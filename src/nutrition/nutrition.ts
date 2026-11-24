import { join } from 'node:path'

import { sql } from 'drizzle-orm'
import { Config, Context, Effect, FileSystem, Layer, Schema, Semaphore } from 'effect'

import type { NUTRITION_SPANS } from '../api/periods.ts'
import { addDays, earlierDay, parisToday } from '../days.ts'
import { Database, type DatabaseError } from '../db.ts'
import { writeAtomic } from '../files.ts'

import { type Classified, dayType, type DoneSession, type PlannedSession } from './day-type.ts'
import { type Lever, type LeverFacts, leversOf, type LeverWindows, leverWindows } from './levers.ts'
import { type PeakWeight, peakWeight } from './peak.ts'
import {
  type DayTarget,
  DEFAULT_PLAN,
  type NutritionPlan,
  NutritionPlanJson,
  type Phase,
  PLAN_PATH,
  phaseOn,
  targetFor,
} from './plan.ts'
import {
  NO_SUPPLEMENTS,
  type Supplement,
  type SupplementDay,
  type Supplements,
  SupplementsJson,
  SUPPLEMENTS_PATH,
  supplementsOn,
} from './supplements.ts'
import {
  type BodyRow,
  type DailyWeighIns,
  dailyWeighIns,
  type Status,
  statusOf,
  type Trend,
  trendOf,
  type WeighIn,
  type WeightDay,
  weightDays,
} from './trend.ts'

// The nutrition page's and the coach's answer: today's target from the day's type, the weight
// trend against the plan, the phase, today's supplements, the peak weight and its levers. The
// plan and the supplements are their files in data/ (read on each request, never in SQLite); the
// weigh-ins, the sessions, the steps and the nights are SQLite's.

export type NutritionSpan = (typeof NUTRITION_SPANS)[number]

export interface NutritionToday {
  readonly today: string
  readonly day: Classified
  readonly target: DayTarget
  readonly phase: Phase | null
  readonly trend: Trend
  readonly status: Status
  readonly latest: WeighIn | null
  readonly supplements: SupplementDay
  readonly peak: PeakWeight
  readonly levers: ReadonlyArray<Lever>
}

export interface NutritionView extends NutritionToday {
  readonly span: NutritionSpan
  readonly plan: NutritionPlan
  // The span's days, oldest first
  readonly days: ReadonlyArray<WeightDay>
}

// The weight protein is counted per kg of: the peak window's mean, else the latest weigh-in
const proteinWeight = (peak: PeakWeight, latest: WeighIn | null) => {
  if (peak.kind !== 'no-weigh-in') return { kg: peak.weight_kg, from: peak.from, to: peak.to }
  return latest === null ? null : { kg: latest.weight_kg, from: latest.day, to: latest.day }
}

// The page's whole answer from what was read: the phase that clips the trend is the one judged
export const nutritionView = (input: {
  readonly plan: NutritionPlan
  readonly today: string
  readonly span: NutritionSpan
  readonly weighIns: DailyWeighIns
  readonly done: ReadonlyArray<DoneSession>
  readonly planned: ReadonlyArray<PlannedSession>
  readonly z4FloorBpm: number | null
  readonly supplements: ReadonlyArray<Supplement>
  readonly facts: LeverFacts
  readonly windows: LeverWindows
}): NutritionView => {
  const { plan, today, span, weighIns } = input
  const day = dayType(input.done, input.planned, input.z4FloorBpm)
  const phase = phaseOn(plan.phases, today)
  const trend = trendOf(weighIns, today, phase?.from ?? null)
  const latest = weighIns.at(-1) ?? null
  const peak = peakWeight({ plan, phase, weighIns, today })
  return {
    today,
    day,
    target: targetFor(plan, day.type),
    phase,
    trend,
    status: statusOf(plan, phase, trend, today),
    latest,
    supplements: supplementsOn(input.supplements, today),
    peak,
    levers: leversOf({
      facts: input.facts,
      windows: input.windows,
      plan,
      weight: proteinWeight(peak, latest),
    }),
    span,
    plan,
    days: weightDays(plan, weighIns, addDays(today, -(span - 1)), today),
  }
}

// What the coach asks of today: the view without its plan and its days
export const todayOf = ({ span: _span, plan: _plan, days: _days, ...today }: NutritionView) =>
  today satisfies NutritionToday

// The plan's or the supplements' file cannot be read or written (its message says why)
export class NutritionError extends Schema.TaggedError<NutritionError>()('NutritionError', {
  message: Schema.String,
}) {}

const decodePlan = Schema.decodeUnknownEffect(Schema.fromJsonString(NutritionPlanJson))
const decodeSupplements = Schema.decodeUnknownEffect(Schema.fromJsonString(SupplementsJson))

// A day's sessions as read: its activities (moving time as the pages count it, minutes in HR zones
// 4–5) and its calendar's workouts
export const sessionsOn = Effect.fnUntraced(function* (day: string) {
  const { use } = yield* Database
  const done = yield* use((db) =>
    db.all<DoneSession>(sql`
      SELECT sport, coalesce(CASE WHEN moving_s > 0 THEN moving_s END, elapsed_s, 0) / 60.0 AS minutes,
        distance_m / 1000.0 AS km,
        (coalesce(hr_z4_s, 0) + coalesce(hr_z5_s, 0)) / 60.0 AS z45_minutes
      FROM activities WHERE day = ${day} ORDER BY start_time`)
  )
  const planned = yield* use((db) =>
    db.all<PlannedSession>(sql`
      SELECT name, description, sport, steps, estimated_duration_s / 60.0 AS minutes,
        estimated_distance_m / 1000.0 AS km
      FROM planned_workouts WHERE day = ${day} ORDER BY id`)
  )
  return { done, planned }
})

// The zone-4 floor of the latest run with zone bounds: hr_zone_bounds holds each zone's top bound,
// zone 3's is zone 4's floor
export const z4Floor = Effect.gen(function* () {
  const { use } = yield* Database
  const [zones] = yield* use((db) =>
    db.all<{ floor: number | null }>(sql`
      SELECT json_extract(hr_zone_bounds, '$[3]') AS floor FROM activities
      WHERE sport LIKE '%running%' AND hr_zone_bounds IS NOT NULL
      ORDER BY start_time DESC LIMIT 1`)
  )
  return zones?.floor ?? null
})

// What the levers read over their windows: the days with an activity, the strength sessions and
// the running km, each day's steps (none and 0, an unworn watch, left out), each night
export const leverFactsOn = Effect.fnUntraced(function* (windows: LeverWindows) {
  const { use } = yield* Database
  const { days, weeks, nights } = windows
  const [counts] = yield* use((db) =>
    db.all<{ active_days: number; strength_sessions: number; running_km: number }>(sql`
      SELECT
        (SELECT count(DISTINCT day) FROM activities WHERE day BETWEEN ${days.from} AND ${days.to})
          AS active_days,
        (SELECT count(*) FROM activities
          WHERE sport = 'strength_training' AND day BETWEEN ${weeks.from} AND ${weeks.to})
          AS strength_sessions,
        (SELECT coalesce(sum(distance_m), 0) / 1000.0 FROM activities
          WHERE sport LIKE '%running%' AND day BETWEEN ${weeks.from} AND ${weeks.to})
          AS running_km`)
  )
  const steps = yield* use((db) =>
    db.all<{ steps: number }>(sql`
      SELECT steps FROM daily WHERE steps > 0 AND day BETWEEN ${days.from} AND ${days.to}
      ORDER BY day`)
  )
  const slept = yield* use((db) =>
    db.all<LeverFacts['nights'][number]>(sql`
      SELECT sleep_s, sleep_start FROM daily WHERE day BETWEEN ${nights.from} AND ${nights.to}
      ORDER BY day`)
  )
  return {
    active_days: counts?.active_days ?? 0,
    strength_sessions: counts?.strength_sessions ?? 0,
    running_km: counts?.running_km ?? 0,
    steps: steps.map((day) => day.steps),
    nights: slept,
  } satisfies LeverFacts
})

export class Nutrition extends Context.Service<
  Nutrition,
  {
    // The plan's file, the plan of 2026-11-16 without one; saved: whether the file exists
    readonly plan: Effect.Effect<
      { readonly plan: NutritionPlan; readonly saved: boolean },
      NutritionError
    >
    readonly setPlan: (plan: NutritionPlan) => Effect.Effect<NutritionPlan, NutritionError>
    // The supplements' file, none without one; saved: whether the file exists
    readonly supplements: Effect.Effect<Supplements & { readonly saved: boolean }, NutritionError>
    readonly setSupplements: (
      supplements: Supplements
    ) => Effect.Effect<Supplements, NutritionError>
    readonly view: (
      span: NutritionSpan
    ) => Effect.Effect<NutritionView, NutritionError | DatabaseError>
  }
>()('garmin/Nutrition') {
  static readonly layer = Layer.effect(
    Nutrition,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const database = yield* Database
      const dataDir = yield* Config.String('DATA_DIR')
      const lock = yield* Semaphore.make(1)

      // Its file, relative to data/, names it in the message
      const broken = (file: string, why: string) =>
        new NutritionError({ message: `${file} : ${why}` })

      // A file of data/ decoded, `fallback` without it; saved: whether the file exists
      const readJson = <A>(
        file: string,
        decode: (text: string) => Effect.Effect<A, { readonly message: string }>,
        fallback: A
      ) =>
        fs.readFileString(join(dataDir, file)).pipe(
          Effect.flatMap((text) =>
            Effect.mapError(decode(text), (error) => broken(file, error.message))
          ),
          Effect.map((value) => ({ value, saved: true })),
          Effect.catchTag('PlatformError', (error) =>
            error.reason._tag === 'NotFound'
              ? Effect.succeed({ value: fallback, saved: false })
              : Effect.fail(broken(file, error.message))
          )
        )

      // A file of data/ replaced whole, one write at a time
      const writeJson = (file: string, value: unknown) =>
        lock
          .withPermits(1)(
            writeAtomic(fs, join(dataDir, file), `${JSON.stringify(value, null, 2)}\n`)
          )
          .pipe(Effect.mapError((error) => broken(file, error.message)))

      const plan = Effect.map(
        readJson(PLAN_PATH, decodePlan, DEFAULT_PLAN),
        ({ value, saved }) => ({ plan: value, saved })
      )

      const setPlan = Effect.fn('Nutrition.setPlan')(function* (next: NutritionPlan) {
        yield* writeJson(PLAN_PATH, next)
        return next
      })

      const supplements = Effect.map(
        readJson(SUPPLEMENTS_PATH, decodeSupplements, NO_SUPPLEMENTS),
        ({ value, saved }) => ({ ...value, saved })
      )

      const setSupplements = Effect.fn('Nutrition.setSupplements')(function* (next: Supplements) {
        yield* writeJson(SUPPLEMENTS_PATH, next)
        return next
      })

      const view = Effect.fn('Nutrition.view')(function* (span: NutritionSpan) {
        const today = yield* parisToday
        const current = (yield* plan).plan
        // The span, and the first phase's start with the week before it: its corridor's anchor
        const since = addDays(
          earlierDay(addDays(today, -(span - 1)), current.phases[0]?.from ?? today),
          -6
        )
        const rows = yield* database.use((db) =>
          db.all<BodyRow>(sql`
            SELECT time, day, weight_kg, body_fat_pct, muscle_mass_kg FROM body
            WHERE weight_kg IS NOT NULL AND day >= ${since} ORDER BY time`)
        )
        const { done, planned } = yield* sessionsOn(today).pipe(
          Effect.provideService(Database, database)
        )
        const windows = leverWindows(today)
        const facts = yield* leverFactsOn(windows).pipe(Effect.provideService(Database, database))
        return nutritionView({
          plan: current,
          today,
          span,
          weighIns: dailyWeighIns(rows),
          done,
          planned,
          z4FloorBpm: yield* z4Floor.pipe(Effect.provideService(Database, database)),
          supplements: (yield* supplements).supplements,
          facts,
          windows,
        })
      })

      return Nutrition.of({ plan, setPlan, supplements, setSupplements, view })
    })
  )
}
