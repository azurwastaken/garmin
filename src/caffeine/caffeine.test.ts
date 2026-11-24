import { existsSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { expect, layer } from '@effect/vitest'
import { Effect, Exit, Layer } from 'effect'

import { dataDir, put, rows, sql, testLayer } from '../../test/fixtures.ts'
import { Ingest, Storage } from '../ingest.ts'

import { Caffeine } from './caffeine.ts'
import { type Instant, intakePath } from './intake.ts'

const TestLayer = testLayer(Caffeine.layer.pipe(Layer.provideMerge(Storage)))

const directory = Effect.map(dataDir, (root) => join(root, 'caffeine', '1970'))
const files = Effect.map(directory, (path) =>
  existsSync(path) ? readdirSync(path).toSorted() : []
)
const tableTimes = rows<{ time: string }>(sql`SELECT time FROM caffeine ORDER BY time`)
const known = rows<{ path: string }>(
  sql`SELECT path FROM raw_files WHERE path LIKE 'caffeine/%' ORDER BY path`
)

// The test clock: frozen at 1970-01-01T00:00:00Z (01:00 in Paris)
layer(TestLayer)('Caffeine', (it) => {
  it.effect('writes each intake to its own file, then ingests it', () =>
    Effect.gen(function* () {
      const caffeine = yield* Caffeine
      // Refused before anything is written
      for (const input of [
        { kind: 'custom' },
        { kind: 'espresso', mg: 9500 },
        { kind: 'espresso', time: '02:00' },
        { kind: 'espresso', day: '1969-12-31' },
      ] as const) {
        expect(Exit.isFailure(yield* caffeine.log(input).pipe(Effect.exit))).toBe(true)
      }
      expect(yield* files).toEqual([])

      const first = yield* caffeine.log({ kind: 'espresso' })
      expect(first).toEqual({ time: '1970-01-01T00:00:00.000Z', kind: 'espresso', mg: 63 })
      // The same millisecond: the next one, never over the first
      const second = yield* caffeine.log({ kind: 'custom', mg: 150, note: 'gel' })
      expect(second.time).toBe('1970-01-01T00:00:00.001Z')
      // 00:15 in Paris
      const earlier = yield* caffeine.log({ kind: 'black_tea', time: '00:15' })
      expect(earlier.time).toBe('1969-12-31T23:15:00.000Z')
      expect(yield* files).toEqual([
        '1970-01-01T00-00-00.000Z.json',
        '1970-01-01T00-00-00.001Z.json',
      ])
      expect(
        yield* rows(sql`SELECT time, day, kind, mg, note FROM caffeine ORDER BY time`)
      ).toEqual([
        { time: earlier.time, day: '1970-01-01', kind: 'black_tea', mg: 47, note: null },
        { time: first.time, day: '1970-01-01', kind: 'espresso', mg: 63, note: null },
        { time: second.time, day: '1970-01-01', kind: 'custom', mg: 150, note: 'gel' },
      ])

      const today = yield* caffeine.today
      expect(today.total_mg).toBe(260)
      expect(today.intakes.map((intake) => intake.clock)).toEqual(['00:15', '01:00', '01:00'])
    })
  )

  it.effect('deletes an intake, file and row; the ingest drops one deleted by hand', () =>
    Effect.gen(function* () {
      const caffeine = yield* Caffeine
      const ingest = yield* Ingest
      const [a, b, c] = yield* Effect.all(
        ['00:20', '00:30', '00:40'].map((time) => caffeine.log({ kind: 'filter', time }))
      )
      if (a === undefined || b === undefined || c === undefined) throw new Error('not logged')

      expect(yield* caffeine.remove(a.time)).toEqual(a)
      // Gone twice: nothing left to delete
      const again = yield* caffeine.remove(a.time).pipe(Effect.flip)
      expect(again._tag).toBe('CaffeineNotFound')

      // By hand, then the next ingest
      rmSync(join(yield* directory, '..', '1969', `${b.time.replaceAll(':', '-')}.json`))
      yield* ingest.run()

      const times = (yield* tableTimes).map((row) => row.time)
      expect(times).toContain(c.time)
      expect(times).not.toContain(a.time)
      expect(times).not.toContain(b.time)
      const paths = (yield* known).map((row) => row.path)
      expect(paths.some((path) => path.includes(a.time.replaceAll(':', '-')))).toBe(false)
      expect(paths.some((path) => path.includes(b.time.replaceAll(':', '-')))).toBe(false)
    })
  )

  it.effect('refuses a file not named by its time, and still ingests the others', () =>
    Effect.gen(function* () {
      const ingest = yield* Ingest
      const time = '1970-01-01T00:00:00.000Z' as Instant
      // A copy of an intake under another name: its time would be taken twice
      yield* put('caffeine/1970/copy.json', { time, kind: 'espresso', mg: 63 })
      const other = '1970-01-01T00:05:00.000Z' as Instant
      yield* put(intakePath(other), { time: other, kind: 'espresso', mg: 63 })
      const summary = yield* ingest.run()
      expect(summary.errors).toEqual([
        `caffeine/1970/copy.json: not a caffeine intake: its name is not its time (${time})`,
      ])
      expect((yield* tableTimes).map((row) => row.time)).toContain(other)
    })
  )

  it.effect('never writes two intakes at once over each other', () =>
    Effect.gen(function* () {
      const caffeine = yield* Caffeine
      const logged = yield* Effect.all(
        [caffeine.log({ kind: 'cola' }), caffeine.log({ kind: 'cola' })],
        { concurrency: 'unbounded' }
      )
      expect(new Set(logged.map((intake) => intake.time)).size).toBe(2)
    })
  )
})
