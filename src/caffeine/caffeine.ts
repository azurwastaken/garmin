import { join } from 'node:path'

import { gte, sql } from 'drizzle-orm'
import {
  Clock,
  Config,
  Context,
  Effect,
  FileSystem,
  Layer,
  Option,
  Result,
  Schema,
  Semaphore,
} from 'effect'

import { INSIGHT_MIN_DAYS } from '../api/periods.ts'
import { addDays, parisInstant, parisToday } from '../days.ts'
import { Database, type DatabaseError } from '../db.ts'
import { writeAtomic } from '../files.ts'
import { Ingest } from '../ingest.ts'
import { caffeine } from '../schema.ts'
import { Stats } from '../stats.ts'

import {
  type CaffeineIntake,
  CaffeineIntakeJson,
  type Instant,
  type IntakeInput,
  instantOf,
  intakePath,
  resolveIntake,
} from './intake.ts'
import {
  bedtimeFrom,
  bedtimeOn,
  type CaffeineDay,
  type CaffeineToday,
  curveOf,
  CUTOFF_BEFORE_MS,
  dailyHistory,
  doseFrom,
  type Moment,
  momentOf,
  todayView,
} from './kinetics.ts'
import {
  type CaffeineNight,
  caffeineNights,
  type CaffeineVsSleep,
  compareNights,
  type NightRow,
} from './sleep.ts'

// The caffeine tracker's writer and reader (the MCP's tools, the Café card and page): an intake is
// resolved, written to its own file in data/caffeine/, then ingested; a mistaken one is deleted by
// its time, file and row. Its file is never written over another's: two intakes in the same
// millisecond take the next free one. The views are estimates from caffeine/kinetics.ts, to
// tonight's bedtime from the sleep analysis (Stats.sleepInsights).

// An intake the tracker cannot take (its message says why, for the caller)
export class CaffeineRefused extends Schema.TaggedError<CaffeineRefused>()('CaffeineRefused', {
  message: Schema.String,
}) {}

export class CaffeineNotFound extends Schema.TaggedError<CaffeineNotFound>()('CaffeineNotFound', {
  message: Schema.String,
}) {}

// The /cafe page: its days of history, today's curve to bedtime, the nights compared
export const PAGE_DAYS = 30

export interface CaffeinePage {
  readonly today: CaffeineToday
  readonly days: ReadonlyArray<CaffeineDay>
  // Minutes after today's midnight (Paris), for the history's line; bedtime_min passes 1440 for a
  // bedtime after midnight
  readonly cutoff_min: number
  readonly bedtime_min: number
  // Every 15 minutes from midnight to bedtime
  readonly curve: ReadonlyArray<Moment & { readonly mg: number }>
  readonly sleep: CaffeineVsSleep
}

export interface CaffeineSleep {
  readonly comparison: CaffeineVsSleep
  readonly nights: ReadonlyArray<CaffeineNight>
}

const decodeFile = Schema.decodeUnknownOption(Schema.fromJsonString(CaffeineIntakeJson))

// The days today's estimates read back: a 1000 mg dose (the most one intake takes) is under 0.5 mg
// after 55 h, 11 half-lives
const RECENT_DAYS = 3

export class Caffeine extends Context.Service<
  Caffeine,
  {
    // The intake as written
    readonly log: (
      input: IntakeInput
    ) => Effect.Effect<CaffeineIntake, Schema.SchemaError | CaffeineRefused>
    // The intake removed
    readonly remove: (time: Instant) => Effect.Effect<CaffeineIntake, CaffeineNotFound>
    readonly today: Effect.Effect<CaffeineToday, DatabaseError>
    readonly page: Effect.Effect<CaffeinePage, DatabaseError>
    readonly sleep: Effect.Effect<CaffeineSleep, DatabaseError>
  }
>()('garmin/Caffeine') {
  static readonly layer = Layer.effect(
    Caffeine,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const ingest = yield* Ingest
      const { use } = yield* Database
      const dataDir = yield* Config.String('DATA_DIR')
      const stats = yield* Stats
      const lock = yield* Semaphore.make(1)

      const fileOf = (time: Instant) => join(dataDir, intakePath(time))

      // The first instant from `at` whose file is free
      const freeTime = (at: number) =>
        Effect.gen(function* () {
          let ms = at
          while (yield* fs.exists(fileOf(instantOf(ms)))) ms += 1
          return instantOf(ms)
        }).pipe(Effect.orDie)

      // On disk, it is done: the ingest every 5 minutes files it if this one fails
      const reingest = ingest.run().pipe(
        Effect.asVoid,
        Effect.catchTag('DatabaseError', (error) =>
          Effect.logWarning('caffeine: file written, its ingest deferred', error)
        )
      )

      const log = Effect.fn('Caffeine.log')(function* (input: IntakeInput) {
        const resolved = resolveIntake(input, {
          now: yield* Clock.currentTimeMillis,
          today: yield* parisToday,
        })
        if (Result.isFailure(resolved)) {
          return yield* new CaffeineRefused({ message: resolved.failure })
        }
        return yield* lock.withPermits(1)(
          Effect.gen(function* () {
            const saved = yield* Schema.decodeUnknownEffect(CaffeineIntakeJson)({
              time: yield* freeTime(resolved.success.at),
              kind: input.kind,
              mg: resolved.success.mg,
              ...(input.note === undefined ? {} : { note: input.note }),
            })
            yield* writeAtomic(fs, fileOf(saved.time), JSON.stringify(saved)).pipe(Effect.orDie)
            yield* reingest
            return saved
          })
        )
      })

      const remove = Effect.fn('Caffeine.remove')(function* (time: Instant) {
        return yield* lock.withPermits(1)(
          Effect.gen(function* () {
            const text = yield* fs.readFileString(fileOf(time)).pipe(Effect.option)
            const saved = Option.flatMap(text, decodeFile)
            if (Option.isNone(saved)) {
              return yield* new CaffeineNotFound({ message: `No caffeine intake at ${time}.` })
            }
            yield* fs.remove(fileOf(time)).pipe(Effect.orDie)
            yield* reingest
            return saved.value
          })
        )
      })

      const rowsSince = (day: string) =>
        use((db) =>
          db.select().from(caffeine).where(gte(caffeine.day, day)).orderBy(caffeine.time).all()
        )

      // Tonight's bedtime: the sleep analysis's over its default span
      const bedtime = Effect.map(stats.sleepInsights(INSIGHT_MIN_DAYS), (insights) =>
        bedtimeFrom(insights.plan)
      )

      const today = Effect.gen(function* () {
        const day = yield* parisToday
        const bed = yield* bedtime
        return todayView({
          today: day,
          now: yield* Clock.currentTimeMillis,
          bedtime: bedtimeOn(day, bed.bed_min),
          source: bed.source,
          recent: yield* rowsSince(addDays(day, -RECENT_DAYS)),
        })
      })

      const sleep = Effect.gen(function* () {
        const rows = yield* use((db) => db.select().from(caffeine).orderBy(caffeine.time).all())
        const nights = yield* use((db) =>
          db.all<NightRow>(sql`
            SELECT day, sleep_start, sleep_score, hrv, resting_hr, deep_s FROM daily
            WHERE sleep_start IS NOT NULL ORDER BY day`)
        )
        const linked = caffeineNights(rows, nights)
        return { comparison: compareNights(linked), nights: linked }
      })

      const page = Effect.gen(function* () {
        const day = yield* parisToday
        const now = yield* Clock.currentTimeMillis
        const bed = yield* bedtime
        const at = bedtimeOn(day, bed.bed_min)
        const rows = yield* rowsSince(addDays(day, -PAGE_DAYS))
        // Midnight always exists in Paris: the clocks change at 02:00 and 03:00
        const midnight = Option.getOrThrow(parisInstant(day, '00:00'))
        // From today's midnight rather than the day before's noon
        const bedtimeMin = bed.bed_min + 720
        return {
          today: todayView({ today: day, now, bedtime: at, source: bed.source, recent: rows }),
          days: dailyHistory(
            rows,
            Array.from({ length: PAGE_DAYS }, (_, index) => addDays(day, index + 1 - PAGE_DAYS))
          ),
          cutoff_min: bedtimeMin - Math.round(CUTOFF_BEFORE_MS / 60_000),
          bedtime_min: bedtimeMin,
          curve: curveOf(
            rows.map((row) => doseFrom(row)),
            midnight,
            at,
            15
          ).map((point) => ({ ...momentOf(point.at), mg: Math.round(point.mg) })),
          sleep: (yield* sleep).comparison,
        } satisfies CaffeinePage
      })

      return Caffeine.of({ log, remove, today, page, sleep })
    })
  )
}
