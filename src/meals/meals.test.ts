import { existsSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { expect, layer } from '@effect/vitest'
import { Effect, Exit, Layer } from 'effect'

import { dataDir, put, rows, sql, testLayer } from '../../test/fixtures.ts'
import { Anatomy } from '../anatomy/anatomy.ts'
import { INSIGHT_MIN_DAYS } from '../api/periods.ts'
import type { Instant } from '../caffeine/intake.ts'
import { addDays } from '../days.ts'
import { Ingest, Storage } from '../ingest.ts'
import { Nutrition } from '../nutrition/nutrition.ts'
import { Stats } from '../stats.ts'
import { Strength } from '../strength/strength.ts'

import { mealPath } from './meal.ts'
import { Meals } from './meals.ts'

const TestLayer = testLayer(
  Meals.layer.pipe(
    Layer.provideMerge(Stats.layer),
    Layer.provideMerge(Strength.layer),
    Layer.provideMerge(Nutrition.layer),
    Layer.provideMerge(Anatomy.layer),
    Layer.provideMerge(Storage)
  )
)

const directory = Effect.map(dataDir, (root) => join(root, 'meals', '1970'))
const files = Effect.map(directory, (path) =>
  existsSync(path) ? readdirSync(path).toSorted() : []
)
const tableTimes = Effect.map(
  rows<{ time: string }>(sql`SELECT time FROM meals ORDER BY time`),
  (found) => found.map((row) => row.time)
)
const known = Effect.map(
  rows<{ path: string }>(sql`SELECT path FROM raw_files WHERE path LIKE 'meals/%'`),
  (found) => found.map((row) => row.path)
)

// The test clock: frozen at 1970-01-01T00:00:00Z (01:00 in Paris)
layer(TestLayer)('Meals', (it) => {
  it.effect('writes each meal to its own file, ingests it, and the sleep page lists today’s', () =>
    Effect.gen(function* () {
      const meals = yield* Meals
      // Refused before anything is written
      for (const input of [
        { kind: 'dinner', day: '1969-12-31' },
        { kind: 'dinner', time: '02:00' },
        { kind: 'dinner', time: '9h30' },
        { kind: 'dinner', day: '1969-02-30', time: '20:00' },
      ] as const) {
        expect(Exit.isFailure(yield* meals.log(input).pipe(Effect.exit))).toBe(true)
      }
      expect(yield* files).toEqual([])

      const first = yield* meals.log({ kind: 'snack' })
      expect(first).toEqual({ time: '1970-01-01T00:00:00.000Z', kind: 'snack' })
      // The same millisecond: the next one, never over the first
      const second = yield* meals.log({ kind: 'dinner', note: 'tard' })
      expect(second.time).toBe('1970-01-01T00:00:00.001Z')
      // Yesterday's dinner, at 20:30 in Paris
      const yesterday = yield* meals.log({ kind: 'dinner', day: '1969-12-31', time: '20:30' })
      expect(yesterday.time).toBe('1969-12-31T19:30:00.000Z')
      expect(yield* files).toEqual([
        '1970-01-01T00-00-00.000Z.json',
        '1970-01-01T00-00-00.001Z.json',
      ])
      expect(yield* rows(sql`SELECT time, day, kind, note FROM meals ORDER BY time`)).toEqual([
        { time: yesterday.time, day: '1969-12-31', kind: 'dinner', note: null },
        { time: first.time, day: '1970-01-01', kind: 'snack', note: null },
        { time: second.time, day: '1970-01-01', kind: 'dinner', note: 'tard' },
      ])

      const view = yield* Stats.use((stats) => stats.sleep(30))
      expect(view.meals).toEqual([
        { time: first.time, day: '1970-01-01', kind: 'snack', note: null, clock: '01:00' },
        { time: second.time, day: '1970-01-01', kind: 'dinner', note: 'tard', clock: '01:00' },
      ])
    })
  )

  it.effect('deletes a meal, file and row; the ingest drops one deleted by hand', () =>
    Effect.gen(function* () {
      const meals = yield* Meals
      const ingest = yield* Ingest
      const [a, b, c] = yield* Effect.all(
        ['00:20', '00:30', '00:40'].map((time) => meals.log({ kind: 'snack', time }))
      )
      if (a === undefined || b === undefined || c === undefined) throw new Error('not logged')

      expect(yield* meals.remove(a.time)).toEqual(a)
      // Gone twice: nothing left to delete
      const again = yield* meals.remove(a.time).pipe(Effect.flip)
      expect(again._tag).toBe('MealNotFound')

      // By hand, then the next ingest
      rmSync(join(yield* directory, '..', '1969', `${b.time.replaceAll(':', '-')}.json`))
      yield* ingest.run()

      const times = yield* tableTimes
      expect(times).toContain(c.time)
      expect(times).not.toContain(a.time)
      expect(times).not.toContain(b.time)
      expect(yield* known).not.toContain(mealPath(a.time))
      expect(yield* known).not.toContain(mealPath(b.time))
      expect(yield* known).toContain(mealPath(c.time))
    })
  )

  it.effect('refuses a file not named by its time, and still ingests the others', () =>
    Effect.gen(function* () {
      const ingest = yield* Ingest
      const time = '1970-01-01T00:00:00.000Z' as Instant
      yield* put('meals/1970/copy.json', { time, kind: 'lunch' })
      const other = '1970-01-01T00:05:00.000Z' as Instant
      yield* put(mealPath(other), { time: other, kind: 'lunch' })
      const summary = yield* ingest.run()
      expect(summary.errors).toEqual([
        `meals/1970/copy.json: not a meal: its name is not its time (${time})`,
      ])
      expect(yield* tableTimes).toContain(other)
    })
  )

  it.effect('never writes two meals at once over each other', () =>
    Effect.gen(function* () {
      const meals = yield* Meals
      const logged = yield* Effect.all(
        [meals.log({ kind: 'lunch' }), meals.log({ kind: 'lunch' })],
        {
          concurrency: 'unbounded',
        }
      )
      expect(new Set(logged.map((meal) => meal.time)).size).toBe(2)
    })
  )
})

// Two weeks of nights to 1970-01-01, asleep 23:00 to 07:00 Paris (UTC+1): enough for a plan
const nights = Effect.forEach(
  Array.from({ length: 14 }, (_, index) => addDays('1970-01-01', -index)),
  (day) =>
    rows(sql`
      INSERT INTO daily (day, sleep_start, sleep_end, sleep_s, awake_s, sleep_score)
      VALUES (${day}, ${`${addDays(day, -1)}T22:00:00.000Z`}, ${`${day}T06:00:00.000Z`},
        27000, 1800, 80)`)
)

layer(TestLayer)('Meals, with a sleep plan', (it) => {
  it.effect('ties the dinners to the nights after them, on the page too', () =>
    Effect.gen(function* () {
      yield* nights
      const meals = yield* Meals
      // Five dinners at 20:00 the evening before, 3 h before sleep; breakfast at 07:30 after the
      // first four (the last morning's is still to come)
      for (const days of [0, 1, 2, 3, 4]) {
        const night = addDays('1970-01-01', -days)
        yield* meals.log({ kind: 'dinner', day: addDays(night, -1), time: '20:00' })
        if (days > 0) yield* meals.log({ kind: 'breakfast', day: night, time: '07:30' })
      }

      const insights = yield* Stats.use((stats) => stats.sleepInsights(INSIGHT_MIN_DAYS))
      if (insights.plan.kind !== 'plan') return expect.fail(`no plan: ${insights.plan.reason}`)
      const { tonight, meal_timing } = insights.plan
      expect(meal_timing).toMatchObject({
        dinner_by: tonight.bed_min - 120,
        breakfast_from: tonight.bed_min - 120 + 720,
        light_from: tonight.wake_min,
      })
      expect(insights.dinner.nights).toHaveLength(5)
      expect(insights.dinner.nights[0]).toMatchObject({
        night: '1969-12-28',
        dinner: '1969-12-27T19:00:00.000Z',
        gap_s: 3 * 3600,
        // 20:00 to 07:30
        fast_s: 11.5 * 3600,
      })
      expect(insights.dinner.nights.at(-1)).toMatchObject({ night: '1970-01-01', fast_s: null })
      expect(insights.dinner.gap.map((bucket) => bucket.nights)).toEqual([0, 0, 5])
      expect(insights.dinner.gap[2]?.recovery.score).toEqual({
        kind: 'measured',
        n: 5,
        mean: 80,
        ci95: 0,
      })

      // The /sleep page reads the same analysis
      const view = yield* Stats.use((stats) => stats.sleep(30))
      expect(view.insights.dinner).toEqual(insights.dinner)
    })
  )
})
