import { join } from 'node:path'

import {
  Cause,
  Clock,
  Config,
  Context,
  Effect,
  FileSystem,
  Layer,
  Option,
  Queue,
  Ref,
  Schema,
  Semaphore,
} from 'effect'
import { HttpClient } from 'effect/http'

import type { DatabaseError } from '../db.ts'
import { writeAtomic } from '../files.ts'
import { describe as describeIngest, Ingest } from '../ingest.ts'
import { parisToday } from '../tools.ts'

import { MEASURE_URL, WithingsError, WithingsLoggedOut, withingsPost } from './client.ts'
import { fetchRange, MEASURE_TYPES, monthFiles, syncMonths, TIME_ZONE } from './measures.ts'
import { type WithingsApp, WithingsSession } from './session.ts'

// Withings → data/withings/YYYY-MM.json → SQLite, on its own loop: a Garmin session lost does not
// stop it. Each run fetches the months syncMonths names (the whole history the first time) with
// getmeas, page by page, then writes one file per month (the groups as they came) once every page
// came: a month file is whole or not written, since its rows replace the month's at the ingest.

const DIR = 'withings'
// A page is hundreds of weigh-ins: a list that never ends is Withings' bug, not a history
const MAX_PAGES = 1000

export type WithingsOutcome =
  | { readonly _tag: 'Synced'; readonly at: string; readonly files_written: number }
  | { readonly _tag: 'LoggedOut'; readonly at: string; readonly error: string }
  | { readonly _tag: 'Failed'; readonly at: string; readonly error: string }

const Page = Schema.Struct({
  measuregrps: Schema.Array(Schema.Unknown),
  timezone: Schema.optional(Schema.NullOr(Schema.String)),
  more: Schema.optional(Schema.NullOr(Schema.Union([Schema.Finite, Schema.Boolean]))),
  offset: Schema.optional(Schema.NullOr(Schema.Finite)),
})
const decodePage = Schema.decodeUnknownOption(Page)

export class WithingsSync extends Context.Service<
  WithingsSync,
  {
    // One sync (one at a time: a second waits for the first)
    readonly run: Effect.Effect<WithingsOutcome>
    // The last run's outcome since the app started
    readonly last: Effect.Effect<WithingsOutcome | null>
    // Wakes the loop now (after connecting, or "sync now")
    readonly trigger: Effect.Effect<void>
    // Every SYNC_EVERY_HOURS (3 by default), or when triggered; without a session, or with one
    // Withings refused, it waits for a new one (checked every minute); without the developer app,
    // never runs
    readonly loop: Effect.Effect<never>
  }
>()('withings/WithingsSync') {
  static readonly layer = Layer.effect(
    WithingsSync,
    Effect.gen(function* () {
      const session = yield* WithingsSession
      const ingest = yield* Ingest
      const http = yield* HttpClient.HttpClient
      const fs = yield* FileSystem.FileSystem
      const dataDir = yield* Config.String('DATA_DIR')
      const everyHours = yield* Config.Number('SYNC_EVERY_HOURS').pipe(Config.withDefault(3))
      const lock = yield* Semaphore.make(1)
      const last = yield* Ref.make<WithingsOutcome | null>(null)
      const wake = yield* Queue.sliding<void>(1)

      const now = Effect.map(Clock.currentTimeMillis, (ms) => new Date(ms).toISOString())

      // The newest month in data/withings/: the last run that completed
      const newestMonth = fs.readDirectory(join(dataDir, DIR)).pipe(
        Effect.map(
          (files) =>
            files
              .filter((file) => /^\d{4}-\d{2}\.json$/u.test(file))
              .toSorted()
              .at(-1)
              ?.slice(0, 7) ?? null
        ),
        Effect.orElseSucceed(() => null)
      )

      // Every page of getmeas over the range; a token refused is refreshed and its page asked once
      // more, refused again: logged out
      const measures = (
        app: WithingsApp,
        range: { readonly startdate: number; readonly enddate: number }
      ) =>
        Effect.gen(function* () {
          let token = yield* app.accessToken()
          const page = (offset: number) =>
            withingsPost(
              http,
              MEASURE_URL,
              {
                action: 'getmeas',
                meastypes: MEASURE_TYPES,
                category: '1',
                startdate: String(range.startdate),
                enddate: String(range.enddate),
                ...(offset === 0 ? {} : { offset: String(offset) }),
              },
              token
            )
          // A page, once more with a refreshed token when Withings refuses this one
          const pageOrRefresh = (offset: number) =>
            page(offset).pipe(
              Effect.catchTag('WithingsRejected', () =>
                Effect.gen(function* () {
                  token = yield* app.accessToken({ rejected: token })
                  return yield* page(offset)
                })
              ),
              Effect.catchTag('WithingsRejected', (error) =>
                Effect.fail(
                  new WithingsLoggedOut({
                    message: `Withings refused a fresh token: ${error.message}`,
                  })
                )
              )
            )
          const groups: Array<unknown> = []
          let timezone: string | null = null
          let offset = 0
          for (let pages = 0; pages < MAX_PAGES; pages += 1) {
            const body = yield* pageOrRefresh(offset)
            const decoded = decodePage(body)
            if (Option.isNone(decoded)) {
              return yield* new WithingsError({
                message: 'getmeas: not a page of measures',
                refused: false,
              })
            }
            groups.push(...decoded.value.measuregrps)
            timezone ??= decoded.value.timezone ?? null
            if (!decoded.value.more) return { groups, timezone: timezone ?? TIME_ZONE }
            const next = decoded.value.offset ?? offset
            if (next <= offset) {
              return yield* new WithingsError({
                message: 'getmeas: its offset does not advance',
                refused: false,
              })
            }
            offset = next
          }
          return yield* new WithingsError({
            message: `getmeas: over ${MAX_PAGES} pages`,
            refused: false,
          })
        })

      const sync = (app: WithingsApp) =>
        Effect.gen(function* () {
          const wanted = syncMonths(yield* newestMonth, yield* parisToday)
          const range = fetchRange(wanted, yield* Clock.currentTimeMillis)
          yield* Effect.logInfo(`syncing Withings from ${wanted[0] ?? '?'}`)
          const { groups, timezone } = yield* measures(app, range)
          const files = monthFiles(groups, timezone, wanted)
          for (const file of files) {
            yield* writeAtomic(
              fs,
              join(dataDir, DIR, `${file.month}.json`),
              JSON.stringify(file)
            ).pipe(
              Effect.mapError(
                (error) =>
                  new WithingsError({ message: `${file.month}: ${error.message}`, refused: false })
              )
            )
          }
          const summary = yield* ingest.run()
          yield* Effect.logInfo(
            `Withings: ${groups.length} weigh-in(s); ingest: ${describeIngest(summary)}`
          )
          return files.length
        })

      const outcomeOf = (
        result: Effect.Effect<number, WithingsLoggedOut | WithingsError | DatabaseError>
      ) =>
        result.pipe(
          Effect.flatMap((files) =>
            Effect.map(now, (at): WithingsOutcome => ({ _tag: 'Synced', at, files_written: files }))
          ),
          Effect.catchTag('WithingsLoggedOut', (error) =>
            Effect.map(now, (at): WithingsOutcome => ({
              _tag: 'LoggedOut',
              at,
              error: error.message,
            }))
          ),
          Effect.catchCause((cause) =>
            Effect.map(now, (at): WithingsOutcome => ({
              _tag: 'Failed',
              at,
              error: Cause.pretty(cause),
            }))
          )
        )

      const run = lock.withPermits(1)(
        Effect.gen(function* () {
          const outcome = yield* Option.match(session.app, {
            onNone: () =>
              Effect.map(now, (at): WithingsOutcome => ({
                _tag: 'Failed',
                at,
                error: 'Withings is off: set WITHINGS_CLIENT_ID and WITHINGS_CLIENT_SECRET',
              })),
            onSome: (app) => outcomeOf(sync(app)),
          })
          yield* Ref.set(last, outcome)
          if (outcome._tag === 'Synced') {
            yield* Effect.logInfo(`Withings sync done: ${outcome.files_written} file(s) written`)
          } else {
            yield* Effect.logError(`Withings sync failed: ${outcome.error}`)
          }
          return outcome
        }).pipe(Effect.withSpan('WithingsSync.run'))
      )

      const waitFor = (minutes: number) =>
        Effect.raceFirst(Effect.sleep(`${minutes} minutes`), Queue.take(wake))

      const loop = Option.match(session.app, {
        onNone: () => Effect.never,
        onSome: () =>
          Effect.gen(function* () {
            // The session Withings refused (its saved_at), not tried again until a new one
            let refused: string | undefined
            for (;;) {
              const saved = yield* session.load
              if (Option.isNone(saved) || saved.value.saved_at === refused) {
                yield* waitFor(1)
                continue
              }
              const outcome = yield* run
              // As saved after the run: a refresh during it may have saved it again
              const after = yield* session.load
              refused =
                outcome._tag === 'LoggedOut'
                  ? Option.getOrUndefined(Option.map(after, (s) => s.saved_at))
                  : undefined
              yield* waitFor(outcome._tag === 'LoggedOut' ? 1 : everyHours * 60)
            }
          }),
      })

      return WithingsSync.of({
        run,
        last: Ref.get(last),
        trigger: Queue.offer(wake, undefined).pipe(Effect.asVoid),
        loop,
      })
    })
  )

  // The background loop, with the app
  static readonly scheduler = Layer.effectDiscard(
    WithingsSync.use((sync) => Effect.forkScoped(sync.loop))
  )
}

// What Withings' redirect to the callback came to, as /garmin says it
export type ConnectResult = 'connected' | 'denied' | 'failed' | 'off'

// The Withings connection as sync_status and /garmin show it
export const withingsStatus = Effect.gen(function* () {
  const session = yield* WithingsSession
  const saved = Option.getOrNull(yield* session.load)
  return {
    // The developer app is set (WITHINGS_CLIENT_ID, WITHINGS_CLIENT_SECRET)
    configured: Option.isSome(session.app),
    user_id: saved?.user_id ?? null,
    saved_at: saved?.saved_at ?? null,
    // The last run since the app started
    last: yield* WithingsSync.use((sync) => sync.last),
  }
})
export type WithingsStatus = Effect.Success<typeof withingsStatus>

// The callback: Withings' code traded for the tokens at once (it lives 30 seconds), then the sync
// woken; the user's refusal or a failure (logged) as a fixed word, never Withings' own text
export const connectFromCallback = (query: {
  readonly code: string | null
  readonly state: string | null
  readonly error: string | null
}) =>
  Effect.gen(function* () {
    const session = yield* WithingsSession
    const sync = yield* WithingsSync
    if (Option.isNone(session.app)) return 'off' satisfies ConnectResult
    if (query.error !== null || query.code === null || query.state === null) {
      return 'denied' satisfies ConnectResult
    }
    return yield* session.app.value.connect({ code: query.code, state: query.state }).pipe(
      Effect.andThen(sync.trigger),
      Effect.as<ConnectResult>('connected'),
      Effect.catchTag('WithingsError', (error) =>
        Effect.as(
          Effect.logError(`Withings connection failed: ${error.message}`),
          'failed' as const
        )
      )
    )
  })
