import { Option, Result, Schema } from 'effect'

import {
  CaffeineIntakeJson,
  type Instant,
  InstantSchema,
  type WhenInput,
} from '../caffeine/intake.ts'
import { parisWall } from '../days.ts'
import type { meals } from '../schema.ts'

// When the user eats, without I/O: one meal per file in data/meals/YYYY/ (the source of truth, as
// every file of data/), named by the instant it was eaten, its key. What was eaten is not tracked:
// the sleep analysis reads only when, and which meal of the day.

export const MEAL_KINDS = ['breakfast', 'lunch', 'snack', 'dinner'] as const
export type MealKind = (typeof MEAL_KINDS)[number]

export const MEAL_LABELS: Record<MealKind, string> = {
  breakfast: 'Petit-déjeuner',
  lunch: 'Déjeuner',
  snack: 'Collation',
  dinner: 'Dîner',
}

export const MealJson = Schema.Struct({
  // When it was eaten
  time: InstantSchema,
  kind: Schema.Literals(MEAL_KINDS),
  note: CaffeineIntakeJson.fields.note,
})
export type Meal = typeof MealJson.Type

// Its file, relative to data/ (no ':' in a file name)
export const mealPath = (time: Instant) =>
  `meals/${time.slice(0, 4)}/${time.replaceAll(':', '-')}.json`

export const decodeMeal = Schema.decodeUnknownOption(MealJson)

export interface MealInput extends WhenInput {
  readonly kind: MealKind
  readonly note?: string | undefined
}

export type MealRow = typeof meals.$inferSelect

// One file's row, its day the Paris day it was eaten; a file not named by its time is refused, so
// the key stays unique and every row can be deleted by its time
const rowOf = (file: {
  readonly path: string
  readonly json: Option.Option<unknown>
}): Result.Result<MealRow, string> =>
  Option.match(Option.flatMap(file.json, decodeMeal), {
    onNone: () => Result.fail('not a meal'),
    onSome: (meal) =>
      mealPath(meal.time) === file.path
        ? Result.succeed({
            time: meal.time,
            day: parisWall(Date.parse(meal.time)).day,
            kind: meal.kind,
            note: meal.note ?? null,
          })
        : Result.fail(`not a meal: its name is not its time (${meal.time})`),
  })

// The meals table from the meal files read (the ingest's part without I/O), and why each refused
// file was
export const mealRows = (
  files: ReadonlyArray<{ readonly path: string; readonly json: Option.Option<unknown> }>
) => {
  const outcomes = files.map((file) => [file.path, rowOf(file)] as const)
  return {
    rows: outcomes.flatMap(([, outcome]) => (Result.isSuccess(outcome) ? [outcome.success] : [])),
    errors: new Map(
      outcomes.flatMap(([path, outcome]) =>
        Result.isFailure(outcome) ? [[path, outcome.failure] as const] : []
      )
    ),
  }
}
