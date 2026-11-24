import { join } from 'node:path'

import { sql } from 'drizzle-orm'
import { Config, Context, Effect, FileSystem, Layer, Schema, Semaphore } from 'effect'

import type { NUTRITION_SPANS } from '../api/periods.ts'
import { addDays, earlierDay, parisToday } from '../days.ts'
import { Database, type DatabaseError } from '../db.ts'
import { writeAtomic } from '../files.ts'

import { type Classified, dayType, type DoneSession, type PlannedSession } from './day-type.ts'
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
// trend against the plan, the phase. The plan is its file in data/ (read on each request, never
// in SQLite); the weigh-ins and the sessions are SQLite's.

export type NutritionSpan = (typeof NUTRITION_SPANS)[number]

export interface NutritionToday {
  readonly today: string
  readonly day: Classified
  readonly target: DayTarget
  readonly phase: Phase | null
  readonly trend: Trend
  readonly status: Status
  readonly latest: WeighIn | null
}

export interface NutritionView extends NutritionToday {
  readonly span: NutritionSpan
  readonly plan: NutritionPlan
  // The span's days, oldest first
  readonly days: ReadonlyArray<WeightDay>
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
}): NutritionView => {
  const { plan, today, span, weighIns } = input
  const day = dayType(input.done, input.planned, input.z4FloorBpm)
  const phase = phaseOn(plan.phases, today)
  const trend = trendOf(weighIns, today, phase?.from ?? null)
  return {
    today,
    day,
    target: targetFor(plan, day.type),
    phase,
    trend,
    status: statusOf(plan, phase, trend, today),
    latest: weighIns.at(-1) ?? null,
    span,
    plan,
    days: weightDays(plan, weighIns, addDays(today, -(span - 1)), today),
  }
}

// What the coach asks of today: the view without its plan and its days
export const todayOf = ({ span: _span, plan: _plan, days: _days, ...today }: NutritionView) =>
  today satisfies NutritionToday

// The plan's file cannot be read or written (its message says why)
export class NutritionError extends Schema.TaggedError<NutritionError>()('NutritionError', {
  message: Schema.String,
}) {}

const decodePlan = Schema.decodeUnknownEffect(Schema.fromJsonString(NutritionPlanJson))

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

export class Nutrition extends Context.Service<
  Nutrition,
  {
    // The plan's file, the plan of 2026-11-16 without one; saved: whether the file exists
    readonly plan: Effect.Effect<
      { readonly plan: NutritionPlan; readonly saved: boolean },
      NutritionError
    >
    readonly setPlan: (plan: NutritionPlan) => Effect.Effect<NutritionPlan, NutritionError>
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
      const path = join(yield* Config.String('DATA_DIR'), PLAN_PATH)
      const lock = yield* Semaphore.make(1)

      const broken = (why: string) => new NutritionError({ message: `${PLAN_PATH} : ${why}` })

      const plan = fs.readFileString(path).pipe(
        Effect.flatMap((text) =>
          Effect.mapError(decodePlan(text), (error) => broken(error.message))
        ),
        Effect.map((read) => ({ plan: read, saved: true })),
        Effect.catchTag('PlatformError', (error) =>
          error.reason._tag === 'NotFound'
            ? Effect.succeed({ plan: DEFAULT_PLAN, saved: false })
            : Effect.fail(broken(error.message))
        )
      )

      const setPlan = Effect.fn('Nutrition.setPlan')(function* (next: NutritionPlan) {
        yield* lock
          .withPermits(1)(writeAtomic(fs, path, `${JSON.stringify(next, null, 2)}\n`))
          .pipe(Effect.mapError((error) => broken(error.message)))
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
        // hr_zone_bounds holds each zone's top bound: zone 3's is zone 4's floor
        const [zones] = yield* database.use((db) =>
          db.all<{ floor: number | null }>(sql`
            SELECT json_extract(hr_zone_bounds, '$[3]') AS floor FROM activities
            WHERE sport LIKE '%running%' AND hr_zone_bounds IS NOT NULL
            ORDER BY start_time DESC LIMIT 1`)
        )
        return nutritionView({
          plan: current,
          today,
          span,
          weighIns: dailyWeighIns(rows),
          done,
          planned,
          z4FloorBpm: zones?.floor ?? null,
        })
      })

      return Nutrition.of({ plan, setPlan, view })
    })
  )
}
