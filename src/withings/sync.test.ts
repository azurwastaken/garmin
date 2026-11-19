import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { expect, layer } from '@effect/vitest'
import { Effect, Option } from 'effect'
import { TestClock } from 'effect/testing'

import { dataDir, put, rows, sql, testLayer } from '../../test/fixtures.ts'
import { fakeGarmin, json, type FakeRequest } from '../../test/garmin.ts'
import { Withings } from '../app.ts'
import { parisToday } from '../days.ts'
import { Database } from '../db.ts'
import { Ingest } from '../ingest.ts'

import { WithingsSession } from './session.ts'
import { connectFromCallback, WithingsSync } from './sync.ts'

const CALLBACK = 'https://garmin.example.com/withings/callback'

// A fake Withings: its token endpoint and getmeas. `refresh` answers the refresh_token grant;
// getmeas refuses `refusedTokens`, then answers `measure` (two pages by default)
interface Fake {
  readonly refresh: (body: URLSearchParams) => Response
  readonly refusedTokens?: ReadonlySet<string>
  readonly measure?: (body: URLSearchParams) => Response
}

let groups: ReadonlyArray<unknown> = []
const twoPages = (body: URLSearchParams) =>
  json({
    status: 0,
    body:
      body.get('offset') === null
        ? { timezone: 'Europe/Paris', measuregrps: groups.slice(0, 1), more: 1, offset: 1 }
        : { timezone: 'Europe/Paris', measuregrps: groups.slice(1), more: 0, offset: 0 },
  })

const withings =
  (fake: Fake) =>
  (request: FakeRequest): Response => {
    const body = new URLSearchParams(request.body)
    if (request.url.pathname === '/v2/oauth2') {
      expect(body.get('client_id')).toBe('client')
      expect(body.get('client_secret')).toBe('secret')
      if (body.get('grant_type') !== 'authorization_code') return fake.refresh(body)
      expect(body.get('redirect_uri')).toBe(CALLBACK)
      expect(body.get('code')).toBe('code-1')
      return json({
        status: 0,
        body: {
          userid: 1234,
          access_token: 'access-1',
          refresh_token: 'refresh-1',
          expires_in: 10_800,
        },
      })
    }
    if (request.url.pathname === '/measure') {
      const token = (request.headers['authorization'] ?? '').replace('Bearer ', '')
      if (fake.refusedTokens?.has(token)) return json({ status: 401 })
      expect(body.get('action')).toBe('getmeas')
      expect(body.get('category')).toBe('1')
      return (fake.measure ?? twoPages)(body)
    }
    return new Response('unexpected', { status: 500 })
  }

const withingsLayer = (fake: Fake) => {
  const http = fakeGarmin(withings(fake))
  return {
    log: http.log,
    layer: testLayer(Withings, http.layer),
  }
}

// Each refresh hands the next pair of tokens
const rotate = (body: URLSearchParams) => {
  const n = Number(body.get('refresh_token')?.split('-')[1] ?? 0) + 1
  return json({
    status: 0,
    body: {
      userid: '1234',
      access_token: `access-${n}`,
      refresh_token: `refresh-${n}`,
      expires_in: 10_800,
    },
  })
}

const sessionPath = Effect.map(Database, ({ path }) =>
  join(dirname(path), 'session', 'withings.json')
)

// Withings' consent asked, its state as the callback brings it back
const authorize = Effect.gen(function* () {
  const app = Option.getOrThrow((yield* WithingsSession).app)
  return new URL(yield* app.authorize(CALLBACK)).searchParams.get('state')
})
const callback = (state: string | null) =>
  connectFromCallback({ code: 'code-1', state, error: null })
const connectNow = Effect.flatMap(authorize, callback)

const run = WithingsSync.use((sync) => sync.run)

let today = ''
const at = (day: string) => Date.parse(`${day}T06:00:00Z`)
const group = (day: string, kg: number) => ({
  grpid: 1,
  attrib: 0,
  date: at(day) / 1000,
  created: 1,
  modified: 1,
  category: 1,
  measures: [{ type: 1, value: kg * 1000, unit: -3 }],
})

const ok = withingsLayer({
  refresh: rotate,
  // The first access token is refused: refreshed, the page asked again
  refusedTokens: new Set(['access-1']),
})

layer(ok.layer, { excludeTestServices: true })('WithingsSync', (it) => {
  it.effect(
    'connects, then syncs every page into data/ and SQLite, refreshing a refused token',
    () =>
      Effect.gen(function* () {
        today = yield* parisToday
        // Two groups of the same second: one weigh-in
        groups = [group(today, 70.4), group(today, 70.2)]
        const session = yield* WithingsSession

        expect(yield* run).toMatchObject({ _tag: 'LoggedOut' })
        // Refused, or not asked here: no session
        expect(
          yield* connectFromCallback({ code: null, state: null, error: 'access_denied' })
        ).toBe('denied')
        expect(yield* callback('forged')).toBe('failed')
        expect(Option.isNone(yield* session.load)).toBe(true)

        // Asked once: its state does not connect twice
        const state = yield* authorize
        expect(yield* callback(state)).toBe('connected')
        expect(yield* callback(state)).toBe('failed')
        expect(statSync(yield* sessionPath).mode & 0o777).toBe(0o600)

        const outcome = yield* run
        expect(outcome).toMatchObject({ _tag: 'Synced' })
        // The whole history the first time: a file a month, empty ones too
        const root = join(yield* dataDir, 'withings')
        const files = readdirSync(root).filter((file) => file.endsWith('.json'))
        expect(files[0]).toBe('2009-01.json')
        expect(files.at(-1)).toBe(`${today.slice(0, 7)}.json`)
        expect(outcome._tag === 'Synced' && outcome.files_written).toBe(files.length)
        expect(yield* rows(sql`SELECT day, weight_kg, source FROM body`)).toEqual([
          { day: today, weight_kg: 70.2, source: 'WITHINGS' },
        ])
        // Refreshed once, the rotated refresh token saved
        expect(Option.getOrThrow(yield* session.load)).toMatchObject({
          access_token: 'access-2',
          refresh_token: 'refresh-2',
          user_id: '1234',
        })
        const pages = ok.log.filter((request) => request.url.pathname === '/measure')
        expect(pages.map((request) => new URLSearchParams(request.body).get('offset'))).toEqual([
          null,
          null,
          '1',
        ])

        // Garmin's month of the same weigh-in and another: the Withings row stays
        yield* put(`connect/body/${today.slice(0, 7)}.json`, {
          startDate: `${today.slice(0, 7)}-01`,
          endDate: today,
          dateWeightList: [
            {
              calendarDate: today,
              timestampGMT: at(today),
              weight: 70_000,
              sourceType: 'INDEX_SCALE',
            },
            {
              calendarDate: today,
              timestampGMT: at(today) + 3_600_000,
              weight: 69_900,
              sourceType: 'INDEX_SCALE',
            },
          ],
        })
        yield* Ingest.use((ingest) => ingest.run())
        expect(yield* rows(sql`SELECT weight_kg, source FROM body ORDER BY time`)).toEqual([
          { weight_kg: 70.2, source: 'WITHINGS' },
          { weight_kg: 69.9, source: 'INDEX_SCALE' },
        ])

        // Again: last month and this one only
        expect(yield* run).toMatchObject({ _tag: 'Synced', files_written: 2 })
      })
  )
})

const refusing = (status: number) =>
  withingsLayer({ refresh: () => json({ status }), refusedTokens: new Set(['access-1']) })

const loggedOut = refusing(401)
layer(loggedOut.layer, { excludeTestServices: true })('WithingsSync, refresh refused', (it) => {
  it.effect('says the session is lost when Withings refuses the refresh', () =>
    Effect.gen(function* () {
      yield* connectNow
      expect(yield* run).toMatchObject({
        _tag: 'LoggedOut',
        error: expect.stringContaining('connect Withings again'),
      })
    })
  )
})

const limited = refusing(601)
layer(limited.layer, { excludeTestServices: true })('WithingsSync, rate limited', (it) => {
  it.effect('fails, keeping the session, when Withings rate limits the refresh', () =>
    Effect.gen(function* () {
      yield* connectNow
      expect(yield* run).toMatchObject({
        _tag: 'Failed',
        error: expect.stringContaining('rate limiting'),
      })
      expect(Option.isSome(yield* WithingsSession.use((session) => session.load))).toBe(true)
    })
  )
})

// Another process refreshed first: Withings refuses the spent refresh token, the file has the
// new session
let racedPath = ''
const raced = withingsLayer({
  refresh: () => {
    writeFileSync(
      racedPath,
      JSON.stringify({
        access_token: 'access-other',
        refresh_token: 'refresh-other',
        user_id: '1234',
        expires_at: '2100-01-01T00:00:00.000Z',
        saved_at: '2100-01-01T00:00:00.000Z',
      })
    )
    return json({ status: 401 })
  },
  refusedTokens: new Set(['access-1']),
  measure: () => json({ status: 0, body: { measuregrps: [], more: 0 } }),
})

layer(raced.layer, { excludeTestServices: true })('WithingsSync, refreshed elsewhere', (it) => {
  it.effect('takes the session another process refreshed', () =>
    Effect.gen(function* () {
      yield* connectNow
      racedPath = yield* sessionPath
      expect(yield* run).toMatchObject({ _tag: 'Synced' })
      const pages = raced.log.filter((request) => request.url.pathname === '/measure')
      expect(pages.at(-1)?.headers['authorization']).toBe('Bearer access-other')
    })
  )
})

// Pages Withings should never send: the run fails, no month is written
const broken: ReadonlyArray<readonly [string, (body: URLSearchParams) => Response]> = [
  ['not a page of measures', () => json({ status: 0, body: { what: 1 } })],
  [
    'its offset does not advance',
    () => json({ status: 0, body: { measuregrps: [], more: 1, offset: 0 } }),
  ],
  [
    'over 1000 pages',
    (body) =>
      json({
        status: 0,
        body: { measuregrps: [], more: true, offset: Number(body.get('offset') ?? 0) + 1 },
      }),
  ],
]

for (const [error, measure] of broken) {
  const hostile = withingsLayer({ refresh: rotate, measure })
  layer(hostile.layer, { excludeTestServices: true })(`WithingsSync, ${error}`, (it) => {
    it.effect('fails without writing a month', () =>
      Effect.gen(function* () {
        yield* connectNow
        expect(yield* run).toMatchObject({
          _tag: 'Failed',
          error: expect.stringContaining(error),
        })
        expect(existsSync(join(yield* dataDir, 'withings'))).toBe(false)
      })
    )
  })
}

// Every access token refused: each run refreshes once, then is logged out
const revoked = withingsLayer({
  refresh: rotate,
  refusedTokens: new Set(Array.from({ length: 10 }, (_, n) => `access-${n}`)),
})

layer(revoked.layer)('WithingsSync, test clock', (it) => {
  it.effect('refuses a state older than 10 minutes', () =>
    Effect.gen(function* () {
      const state = yield* authorize
      yield* TestClock.adjust('11 minutes')
      expect(yield* callback(state)).toBe('failed')
    })
  )

  it.effect('does not try a refused session again', () =>
    Effect.gen(function* () {
      // Saved before the test clock's time: the refresh's save has another saved_at
      const file = yield* sessionPath
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(
        file,
        JSON.stringify({
          access_token: 'access-1',
          refresh_token: 'refresh-1',
          user_id: '1234',
          expires_at: '2100-01-01T00:00:00.000Z',
          saved_at: '2026-01-01T00:00:00.000Z',
        })
      )
      const sync = yield* WithingsSync
      const refreshes = () =>
        revoked.log.filter(
          (request) => new URLSearchParams(request.body).get('grant_type') === 'refresh_token'
        ).length
      // The run's files and fake calls are real I/O, not the test clock's
      const pause = Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 20)))
      yield* Effect.forkScoped(sync.loop)
      while ((yield* sync.last) === null) yield* pause
      expect(yield* sync.last).toMatchObject({ _tag: 'LoggedOut' })
      expect(refreshes()).toBe(1)
      for (const step of ['1 minute', '3 hours', '1 minute'] as const) {
        yield* TestClock.adjust(step)
        yield* pause
        yield* pause
      }
      expect(refreshes()).toBe(1)
      expect(existsSync(file)).toBe(true)
    })
  )
})
