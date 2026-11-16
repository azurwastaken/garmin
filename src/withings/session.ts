import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

import {
  Clock,
  Config,
  Context,
  Effect,
  FileSystem,
  Layer,
  Option,
  Redacted,
  Ref,
  Schema,
  Semaphore,
} from 'effect'
import { HttpClient } from 'effect/http'

import { writeAtomic } from '../files.ts'

import {
  TOKEN_URL,
  WithingsError,
  WithingsLoggedOut,
  type WithingsRejected,
  withingsPost,
} from './client.ts'
import {
  authorizeUrl,
  expiresSoon,
  tokensOf,
  type WithingsTokens,
  WithingsTokensJson,
} from './measures.ts'

// The Withings account, connected with OAuth 2 from /garmin: the app's Withings developer app
// (WITHINGS_CLIENT_ID, WITHINGS_CLIENT_SECRET; without them Withings is off) and the user's tokens,
// in their own file (WITHINGS_SESSION_PATH, 0600 in a 0700 directory), never in SQLite nor in
// data/, never logged. Each refresh hands a new refresh token: it is saved before the new access
// token is used (the old one dies with that first use), one refresh at a time.

const SavedJson = Schema.Struct({ ...WithingsTokensJson.fields, saved_at: Schema.String })
export type Saved = typeof SavedJson.Type

const decode = Schema.decodeUnknownOption(Schema.fromJsonString(SavedJson))

const CONNECT_HINT = 'connect Withings again on the web app (/garmin)'
// Withings' code lives 30 seconds, the user's consent a few minutes
const PENDING_FOR_MS = 10 * 60 * 1000

// What needs the developer app
export interface WithingsApp {
  // Withings' consent page, coming back to `redirectUri` with a state asked once, 10 minutes
  readonly authorize: (redirectUri: string) => Effect.Effect<string>
  // The code Withings came back with, traded for the tokens, saved
  readonly connect: (callback: {
    readonly code: string
    readonly state: string
  }) => Effect.Effect<Saved, WithingsError>
  // A valid access token, refreshed (and saved) when it expires within 15 minutes, or when it is
  // `rejected` (a call's 401) and no other call refreshed it meanwhile
  readonly accessToken: (options?: {
    readonly rejected?: string
  }) => Effect.Effect<string, WithingsLoggedOut | WithingsError>
}

export class WithingsSession extends Context.Service<
  WithingsSession,
  {
    // The saved session, none without a file (or an unreadable one)
    readonly load: Effect.Effect<Option.Option<Saved>>
    readonly clear: Effect.Effect<void, WithingsError>
    // None: no developer app configured, Withings is off
    readonly app: Option.Option<WithingsApp>
  }
>()('withings/WithingsSession') {
  static readonly layer = Layer.effect(
    WithingsSession,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const http = yield* HttpClient.HttpClient
      const path = yield* Config.String('WITHINGS_SESSION_PATH').pipe(
        Config.withDefault(join('.tokens', 'withings.json'))
      )
      const credentials = yield* Config.option(
        Config.all({
          clientId: Config.String('WITHINGS_CLIENT_ID'),
          clientSecret: Config.Redacted('WITHINGS_CLIENT_SECRET'),
        })
      )
      const lock = yield* Semaphore.make(1)
      const pending = yield* Ref.make(
        new Map<string, { readonly redirectUri: string; readonly until: number }>()
      )

      const load = fs.readFileString(path).pipe(
        Effect.map(decode),
        Effect.orElseSucceed(() => Option.none<Saved>())
      )

      const save = (tokens: WithingsTokens) =>
        Effect.gen(function* () {
          const saved: Saved = {
            ...tokens,
            saved_at: new Date(yield* Clock.currentTimeMillis).toISOString(),
          }
          yield* writeAtomic(fs, path, JSON.stringify(saved), { mode: 0o600, dirMode: 0o700 })
          return saved
        }).pipe(
          Effect.mapError(
            (error) =>
              new WithingsError({ message: `saving the session: ${error.message}`, refused: false })
          )
        )

      const clear = fs.remove(path, { force: true }).pipe(
        Effect.mapError(
          (error) =>
            new WithingsError({
              message: `forgetting the session: ${error.message}`,
              refused: false,
            })
        )
      )

      const app = Option.map(credentials, ({ clientId, clientSecret }): WithingsApp => {
        const secret = Redacted.value(clientSecret)

        // requesttoken's answer as tokens
        const requestToken = (params: Readonly<Record<string, string>>) =>
          withingsPost(http, TOKEN_URL, {
            action: 'requesttoken',
            client_id: clientId,
            client_secret: secret,
            ...params,
          }).pipe(
            Effect.flatMap((body) =>
              Effect.gen(function* () {
                const tokens = tokensOf(body, yield* Clock.currentTimeMillis)
                if (tokens === null) {
                  return yield* new WithingsError({
                    message: 'requesttoken: an answer without tokens',
                    refused: false,
                  })
                }
                return tokens
              })
            )
          )

        const authorize = (redirectUri: string) =>
          Effect.gen(function* () {
            const state = randomUUID()
            const now = yield* Clock.currentTimeMillis
            yield* Ref.update(
              pending,
              (map) =>
                new Map([
                  ...[...map].filter(([, entry]) => entry.until > now),
                  [state, { redirectUri, until: now + PENDING_FOR_MS }],
                ])
            )
            return authorizeUrl({ clientId, redirectUri, state })
          })

        const connect = Effect.fn('WithingsSession.connect')(function* (callback: {
          readonly code: string
          readonly state: string
        }) {
          const now = yield* Clock.currentTimeMillis
          // Asked once: taken out as it is read
          const entry = yield* Ref.modify(pending, (map) => {
            const found = map.get(callback.state)
            const rest = new Map(map)
            rest.delete(callback.state)
            return [found, rest]
          })
          if (entry === undefined || entry.until < now) {
            return yield* new WithingsError({
              message: 'this connection expired or was not asked here: connect again',
              refused: true,
            })
          }
          const tokens = yield* requestToken({
            grant_type: 'authorization_code',
            code: callback.code,
            redirect_uri: entry.redirectUri,
          }).pipe(
            Effect.catchTag('WithingsRejected', (error: WithingsRejected) =>
              Effect.fail(new WithingsError({ message: error.message, refused: true }))
            )
          )
          const saved = yield* save(tokens)
          yield* Effect.logInfo(`Withings: connected user ${saved.user_id}`)
          return saved
        })

        const loggedOut = (message: string) =>
          new WithingsLoggedOut({ message: `${message}: ${CONNECT_HINT}` })

        const accessToken = (options?: { readonly rejected?: string }) =>
          lock.withPermits(1)(
            Effect.gen(function* () {
              const saved = yield* load
              if (Option.isNone(saved)) return yield* loggedOut('no Withings session')
              const rejected = options?.rejected === saved.value.access_token
              if (!rejected && !expiresSoon(saved.value, yield* Clock.currentTimeMillis)) {
                return saved.value.access_token
              }
              const refreshed = yield* requestToken({
                grant_type: 'refresh_token',
                refresh_token: saved.value.refresh_token,
              }).pipe(
                Effect.map((fresh) => ({ fresh })),
                Effect.catchTag('WithingsRejected', (error) =>
                  Effect.succeed({ refused: error.message })
                ),
                Effect.catchTag('WithingsError', (error) =>
                  error.refused ? Effect.succeed({ refused: error.message }) : Effect.fail(error)
                )
              )
              if ('refused' in refreshed) {
                // Another process (a CLI beside the app) may have refreshed it first: its session
                // is in the file
                const now = yield* load
                if (
                  Option.isSome(now) &&
                  now.value.refresh_token !== saved.value.refresh_token &&
                  !expiresSoon(now.value, yield* Clock.currentTimeMillis)
                ) {
                  return now.value.access_token
                }
                return yield* loggedOut(`Withings refused the refresh (${refreshed.refused})`)
              }
              const fresh = yield* save(refreshed.fresh)
              yield* Effect.logInfo(`Withings session refreshed, valid until ${fresh.expires_at}`)
              return fresh.access_token
            })
          )

        return { authorize, connect, accessToken }
      })

      return WithingsSession.of({ load, clear, app })
    })
  )
}
