import { Option, Result, Schema } from 'effect'

import { parisInstant, parisWall } from '../days.ts'
import type { caffeine } from '../schema.ts'

// The caffeine the user drinks, without I/O: one intake per file in data/caffeine/YYYY/ (the source
// of truth, as every file of data/), named by the instant it was drunk, its key

// Caffeine of one serving, mg. USDA FoodData Central: espresso 212 mg/100 g (a 30 ml shot), brewed
// coffee 40 mg/100 g (a 240 ml mug), black tea 20 mg/100 g and green tea 12 mg/100 g (237 ml). The
// cans' labels: Coca-Cola 32 mg/330 ml, Red Bull 80 mg/250 ml, Monster 160 mg/500 ml. Nespresso
// ~60 mg a capsule (the brand gives ~50–120). EFSA 2015 (EFSA Journal 13(5):4102) quotes the same
// orders of magnitude. A pre-workout or a caffeinated gel says its own on its label.
export const DRINKS = {
  espresso: { label: 'Espresso', mg: 63 },
  double_espresso: { label: 'Double espresso', mg: 126 },
  filter: { label: 'Café filtre / allongé', mg: 95 },
  capsule: { label: 'Capsule Nespresso', mg: 60 },
  cappuccino: { label: 'Cappuccino / latte', mg: 63 },
  black_tea: { label: 'Thé noir', mg: 47 },
  green_tea: { label: 'Thé vert', mg: 28 },
  cola: { label: 'Coca-Cola 33 cl', mg: 32 },
  red_bull: { label: 'Red Bull 25 cl', mg: 80 },
  monster: { label: 'Monster 50 cl', mg: 160 },
  custom: { label: 'Autre (pré-workout, gel…)', mg: null },
} as const satisfies Record<string, { readonly label: string; readonly mg: number | null }>
export type DrinkKind = keyof typeof DRINKS

// The catalog's keys as a tuple, for Schema.Literals (a test keeps it equal to DRINKS')
export const DRINK_KINDS = [
  'espresso',
  'double_espresso',
  'filter',
  'capsule',
  'cappuccino',
  'black_tea',
  'green_tea',
  'cola',
  'red_bull',
  'monster',
  'custom',
] as const satisfies ReadonlyArray<DrinkKind>

// One serving: a typo (9 500) is refused
export const Mg = Schema.Finite.check(Schema.isBetween({ minimum: 1, maximum: 1000 }))

// Its own patterns, as journal/note.ts: the ingest's CLI does not load the API's
const Day = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/u))
export const ClockSchema = Schema.String.check(Schema.isPattern(/^(?:[01]\d|2[0-3]):[0-5]\d$/u))

// An instant as toISOString writes it, and a real one: the key and the file name, so nothing else
// (no '/', no '..') ever reaches a path
export const InstantSchema = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u),
  Schema.makeFilter((time: string) => {
    const date = new Date(time)
    return (
      (!Number.isNaN(date.getTime()) && date.toISOString() === time) ||
      'an instant as toISOString writes it'
    )
  })
).pipe(Schema.brand('Instant'))
export type Instant = typeof InstantSchema.Type

// toISOString's output always passes Instant: its one constructor from epoch ms
export const instantOf = (ms: number) => new Date(ms).toISOString() as Instant

export const CaffeineIntakeJson = Schema.Struct({
  // When it was drunk
  time: InstantSchema,
  kind: Schema.Literals(DRINK_KINDS),
  mg: Mg,
  note: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200))),
})
export type CaffeineIntake = typeof CaffeineIntakeJson.Type

// Its file, relative to data/ (no ':' in a file name)
export const intakePath = (time: Instant) =>
  `caffeine/${time.slice(0, 4)}/${time.replaceAll(':', '-')}.json`

export const decodeIntake = Schema.decodeUnknownOption(CaffeineIntakeJson)

// When something was had, as said: YYYY-MM-DD and HH:MM in Paris
export interface WhenInput {
  readonly day?: string | undefined
  readonly time?: string | undefined
}

export interface IntakeInput extends WhenInput {
  readonly kind: DrinkKind
  readonly mg?: number | undefined
  readonly note?: string | undefined
}

// A tap a few minutes ahead of the server's clock is still now
const AHEAD_MS = 5 * 60_000

// The instant said (epoch ms): now by default, else the day (default today) at HH:MM in Paris.
// Refused, with the reason: a day without a time, an HH:MM that is not one, a time in the future.
export const resolveAt = (
  input: WhenInput,
  context: { readonly now: number; readonly today: string }
): Result.Result<number, string> => {
  if (input.time === undefined) {
    return input.day === undefined
      ? Result.succeed(context.now)
      : Result.fail(`Le ${input.day} sans heure : donne aussi l’heure (HH:MM).`)
  }
  const day = input.day ?? context.today
  if (!Schema.is(Day)(day) || !Schema.is(ClockSchema)(input.time)) {
    return Result.fail(
      `« ${day} ${input.time} » n’est pas un jour (AAAA-MM-JJ) et une heure (HH:MM).`
    )
  }
  return Option.match(parisInstant(day, input.time), {
    onNone: () => Result.fail(`Le ${day} à ${input.time} n’existe pas à Paris.`),
    onSome: (at) =>
      at > context.now + AHEAD_MS
        ? Result.fail(`Le ${day} à ${input.time} est dans le futur.`)
        : Result.succeed(at),
  })
}

// When and how much, from what was said: resolveAt's instant, the catalog's mg unless given; a drink
// of the "custom" kind without its mg is refused too
export const resolveIntake = (
  input: IntakeInput,
  context: { readonly now: number; readonly today: string }
): Result.Result<{ readonly at: number; readonly mg: number }, string> => {
  const mg = input.mg ?? DRINKS[input.kind].mg
  if (mg === null) return Result.fail('Un « autre » a besoin de ses mg de caféine.')
  return Result.map(resolveAt(input, context), (at) => ({ at, mg }))
}

export type CaffeineRow = typeof caffeine.$inferSelect

// One file's row, its day the Paris day it was drunk; a file not named by its time is refused, so
// the key stays unique and every row can be deleted by its time
const rowOf = (file: {
  readonly path: string
  readonly json: Option.Option<unknown>
}): Result.Result<CaffeineRow, string> =>
  Option.match(Option.flatMap(file.json, decodeIntake), {
    onNone: () => Result.fail('not a caffeine intake'),
    onSome: (intake) =>
      intakePath(intake.time) === file.path
        ? Result.succeed({
            time: intake.time,
            day: parisWall(Date.parse(intake.time)).day,
            kind: intake.kind,
            mg: intake.mg,
            note: intake.note ?? null,
          })
        : Result.fail(`not a caffeine intake: its name is not its time (${intake.time})`),
  })

// The caffeine table from the intake files read (the ingest's part without I/O), and why each
// refused file was
export const caffeineRows = (
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
