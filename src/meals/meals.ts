import { join } from 'node:path'

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

import { type Instant, instantOf, resolveAt } from '../caffeine/intake.ts'
import { parisToday } from '../days.ts'
import { writeAtomic } from '../files.ts'
import { Ingest } from '../ingest.ts'

import { type Meal, type MealInput, MealJson, mealPath } from './meal.ts'

// The meal log's writer (the MCP's log_meal and delete_meal, the /sleep page's card): a meal is
// resolved, written to its own file in data/meals/, then ingested; a mistaken one is deleted by its
// time, file and row. Its file is never written over another's: two meals in the same millisecond
// take the next free one. The sleep analysis reads the meals table (Stats.sleepInsights).
// shortcut: the same writer as caffeine/caffeine.ts's, not shared with it while caffeine is changed
// on another branch; fold both onto one once that branch is merged

// A meal the log cannot take (its message says why, for the caller)
export class MealRefused extends Schema.TaggedError<MealRefused>()('MealRefused', {
  message: Schema.String,
}) {}

export class MealNotFound extends Schema.TaggedError<MealNotFound>()('MealNotFound', {
  message: Schema.String,
}) {}

const decodeFile = Schema.decodeUnknownOption(Schema.fromJsonString(MealJson))

export class Meals extends Context.Service<
  Meals,
  {
    // The meal as written
    readonly log: (input: MealInput) => Effect.Effect<Meal, Schema.SchemaError | MealRefused>
    // The meal removed
    readonly remove: (time: Instant) => Effect.Effect<Meal, MealNotFound>
  }
>()('garmin/Meals') {
  static readonly layer = Layer.effect(
    Meals,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const ingest = yield* Ingest
      const dataDir = yield* Config.String('DATA_DIR')
      const lock = yield* Semaphore.make(1)

      const fileOf = (time: Instant) => join(dataDir, mealPath(time))

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
          Effect.logWarning('meals: file written, its ingest deferred', error)
        )
      )

      const log = Effect.fn('Meals.log')(function* (input: MealInput) {
        const at = resolveAt(input, {
          now: yield* Clock.currentTimeMillis,
          today: yield* parisToday,
        })
        if (Result.isFailure(at)) return yield* new MealRefused({ message: at.failure })
        return yield* lock.withPermits(1)(
          Effect.gen(function* () {
            const saved = yield* Schema.decodeUnknownEffect(MealJson)({
              time: yield* freeTime(at.success),
              kind: input.kind,
              ...(input.note === undefined ? {} : { note: input.note }),
            })
            yield* writeAtomic(fs, fileOf(saved.time), JSON.stringify(saved)).pipe(Effect.orDie)
            yield* reingest
            return saved
          })
        )
      })

      const remove = Effect.fn('Meals.remove')(function* (time: Instant) {
        return yield* lock.withPermits(1)(
          Effect.gen(function* () {
            const text = yield* fs.readFileString(fileOf(time)).pipe(Effect.option)
            const saved = Option.flatMap(text, decodeFile)
            if (Option.isNone(saved)) {
              return yield* new MealNotFound({ message: `No meal at ${time}.` })
            }
            yield* fs.remove(fileOf(time)).pipe(Effect.orDie)
            yield* reingest
            return saved.value
          })
        )
      })

      return Meals.of({ log, remove })
    })
  )
}
