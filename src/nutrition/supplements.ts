import { Schema, SchemaTransformation } from 'effect'

import { addDays, daysBetween } from '../days.ts'
import { round } from '../numbers.ts'

import { Between, Day, Text } from './plan.ts'

// The supplements the user takes, without I/O: data/nutrition/supplements.json (the source of
// truth, as every file of data/), read on each request like the plan. What to take today and
// when, and each nutrient's daily average against its upper limit where one exists.

export const MOMENTS = ['breakfast', 'lunch', 'dinner', 'bedtime', 'run'] as const
export type Moment = (typeof MOMENTS)[number]

export const UNITS = ['g', 'mg', '\u00B5g'] as const
export type Unit = (typeof UNITS)[number]

// MCP clients NFKC-normalise the tool descriptions, which turns the file's micro sign (U+00B5)
// into a Greek mu (U+03BC): the model sends that spelling back. Escapes: the glyphs look the same
const GREEK_MICRO = '\u03BCg'

// Either spelling in, the file's one out; the description on the encoded side, which the tool's
// input JSON Schema is built from
const UnitJson = Schema.Literals([...UNITS, GREEK_MICRO])
  .annotate({ description: 'Vitamin D in µg (1 µg = 40 IU)' })
  .pipe(
    Schema.decodeTo(
      Schema.Literals(UNITS),
      SchemaTransformation.transform({
        decode: (unit) => (unit === GREEK_MICRO ? '\u00B5g' : unit),
        encode: (unit) => unit,
      })
    )
  )

export const SUPPLEMENTS_PATH = 'nutrition/supplements.json'

const Units = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20 }))

const Intake = Schema.Struct({ moment: Schema.Literals(MOMENTS), units: Units })

const Content = Schema.Struct({
  nutrient: Schema.String.check(Schema.isPattern(/^[a-z0-9_]{1,40}$/u)).annotate({
    description:
      'A slug; these carry an upper limit or a caution: vitamin_d, magnesium, zinc, vitamin_b6, ashwagandha',
  }),
  amount: Between(0, 1_000_000),
  unit: UnitJson,
  // The salt or the extract: bisglycinate, KSM-66, MK-7
  form: Schema.optionalKey(Text(60)),
})

export const SupplementJson = Schema.Struct({
  name: Text(120),
  brand: Text(80),
  unit_name: Text(30).annotate({ description: 'What one unit is: gélule, comprimé, dose' }),
  intakes: Schema.Array(Intake)
    .check(Schema.isMinLength(1))
    .check(
      Schema.makeFilter(
        (intakes) =>
          new Set(intakes.map((intake) => intake.moment)).size === intakes.length ||
          'intakes : chaque moment une seule fois'
      )
    )
    .annotate({ description: 'When it is taken, and how many units each time' }),
  serving_units: Units.annotate({ description: 'How many units the contents are for' }),
  contents: Schema.Array(Content).annotate({ description: 'Per serving (serving_units units)' }),
  every_days: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 60 })).annotate({
    description: '1 = daily; N = every N days, counted from start (its first intake)',
  }),
  start: Day,
  // Its last day, included
  stop: Schema.optionalKey(Day),
  note: Schema.optionalKey(Text(500)),
}).check(
  Schema.makeFilter(
    (supplement) =>
      supplement.stop === undefined ||
      supplement.start <= supplement.stop ||
      'complément : start ≤ stop'
  )
)
export type Supplement = typeof SupplementJson.Type

export const SupplementsJson = Schema.Struct({ supplements: Schema.Array(SupplementJson) })
export type Supplements = typeof SupplementsJson.Type

// Without the file
export const NO_SUPPLEMENTS: Supplements = { supplements: [] }

export interface UpperLimit {
  readonly amount: number
  readonly unit: Unit
  // What it bounds: the supplements alone, or the whole intake, food included
  readonly scope: 'supplements' | 'total'
  readonly source: string
  // What going over risks first
  readonly risk: string
}

// The tolerable upper intake levels for adults, by nutrient slug
export const UPPER_LIMITS: Readonly<Record<string, UpperLimit>> = {
  vitamin_d: {
    amount: 100,
    unit: 'µg',
    scope: 'total',
    source: 'EFSA 2023 (100 µg = 4 000 UI)',
    risk: 'hypercalcémie',
  },
  magnesium: {
    amount: 250,
    unit: 'mg',
    scope: 'supplements',
    source: 'EFSA 2006 (SCF 2001), magnésium des compléments en sels facilement dissociables',
    risk: 'surtout un effet laxatif',
  },
  zinc: {
    amount: 25,
    unit: 'mg',
    scope: 'total',
    source: 'EFSA 2006 (SCF 2002)',
    risk: 'à la longue, un manque de cuivre',
  },
  vitamin_b6: {
    amount: 12,
    unit: 'mg',
    scope: 'total',
    source: 'EFSA 2023',
    risk: 'neuropathie périphérique',
  },
}

// What to know of a nutrient without an upper limit, by slug
export const CAUTIONS: Readonly<Record<string, string>> = {
  ashwagandha:
    'Pas de limite officielle. ANSES 2024 : déconseillée en cas de maladie de la thyroïde, du foie ou du cœur, avec des sédatifs, et pendant la grossesse.',
}

export type Schedule =
  // Its stop day has passed
  | { readonly kind: 'stopped' }
  // It starts later: next is its start
  | { readonly kind: 'upcoming'; readonly next: string }
  // A dose day or not; next: the next dose day after it, null past its stop
  | { readonly kind: 'dose' | 'off'; readonly next: string | null }

// Where `day` falls in a supplement's rhythm: every `every_days` days from its start, to its stop
export const scheduleOn = (
  supplement: Pick<Supplement, 'start' | 'stop' | 'every_days'>,
  day: string
): Schedule => {
  const { start, stop, every_days: every } = supplement
  if (stop !== undefined && day > stop) return { kind: 'stopped' }
  if (day < start) return { kind: 'upcoming', next: start }
  const since = daysBetween(start, day) % every
  const next = addDays(day, every - since)
  return {
    kind: since === 0 ? 'dose' : 'off',
    next: stop !== undefined && next > stop ? null : next,
  }
}

const MICROGRAMS: Record<Unit, number> = { g: 1_000_000, mg: 1000, µg: 1 }

// An amount from one unit to another
const inUnit = (amount: number, from: Unit, to: Unit) =>
  (amount * MICROGRAMS[from]) / MICROGRAMS[to]

export type NutrientTotal = {
  readonly nutrient: string
  readonly per_day: number
  readonly unit: Unit
  readonly caution: string | null
} & (
  | { readonly status: 'no-limit'; readonly limit: null }
  // per_day against the limit, in its unit: over only past it
  | { readonly status: 'over' | 'under'; readonly limit: UpperLimit }
)

// The daily average of each nutrient over the supplements given (its amount × the units taken a
// day ÷ the serving's units ÷ every_days), in its limit's unit when it has one, else in its first
// amount's; in the order they first appear
// shortcut: a `run` intake counts as daily here and is listed on every dose day by
// supplementsOn, run or not; upgrade both when one is entered (none today)
export const nutrientTotals = (supplements: ReadonlyArray<Supplement>): Array<NutrientTotal> => {
  const doses = supplements.flatMap((supplement) => {
    const units = supplement.intakes.reduce((sum, intake) => sum + intake.units, 0)
    const share = units / supplement.serving_units / supplement.every_days
    return supplement.contents.map((content) => ({ ...content, amount: content.amount * share }))
  })
  return [...Map.groupBy(doses, (dose) => dose.nutrient)].map(([nutrient, same]) => {
    const limit = UPPER_LIMITS[nutrient] ?? null
    const unit = limit?.unit ?? same[0]?.unit ?? 'mg'
    const perDay =
      round(
        same.reduce((sum, dose) => sum + inUnit(dose.amount, dose.unit, unit), 0),
        2
      ) ?? 0
    const caution = CAUTIONS[nutrient] ?? null
    return limit === null
      ? { nutrient, per_day: perDay, unit, caution, status: 'no-limit', limit }
      : {
          nutrient,
          per_day: perDay,
          unit,
          caution,
          status: perDay > limit.amount ? 'over' : 'under',
          limit,
        }
  })
}

export interface SupplementDay {
  readonly today: string
  // Each moment with what to take today, in MOMENTS order, the empty ones left out
  readonly moments: ReadonlyArray<{
    readonly moment: Moment
    readonly take: ReadonlyArray<{
      readonly name: string
      readonly brand: string
      readonly units: number
      readonly unit_name: string
    }>
  }>
  // Every supplement not stopped, with its schedule, in the file's order
  readonly items: ReadonlyArray<{
    readonly name: string
    readonly brand: string
    readonly every_days: number
    readonly schedule: Exclude<Schedule, { readonly kind: 'stopped' }>
  }>
  // The daily averages from `from` (the latest start among the supplements not stopped, today at
  // the earliest), over the supplements taken that day
  readonly totals: { readonly from: string; readonly nutrients: ReadonlyArray<NutrientTotal> }
}

// Today's supplements: what to take at each moment, each one's rhythm, and the daily averages
// once every supplement not stopped has started
export const supplementsOn = (
  supplements: ReadonlyArray<Supplement>,
  today: string
): SupplementDay => {
  const current = supplements.flatMap((supplement) => {
    const schedule = scheduleOn(supplement, today)
    return schedule.kind === 'stopped' ? [] : [{ supplement, schedule }]
  })
  const dosed = current.filter(({ schedule }) => schedule.kind === 'dose')
  const from = current.reduce(
    (latest, { supplement }) => (supplement.start > latest ? supplement.start : latest),
    today
  )
  return {
    today,
    moments: MOMENTS.map((moment) => ({
      moment,
      take: dosed.flatMap(({ supplement: { name, brand, unit_name, intakes } }) =>
        intakes
          .filter((intake) => intake.moment === moment)
          .map((intake) => ({ name, brand, units: intake.units, unit_name }))
      ),
    })).filter((moment) => moment.take.length > 0),
    items: current.map(({ supplement: { name, brand, every_days }, schedule }) => ({
      name,
      brand,
      every_days,
      schedule,
    })),
    totals: {
      from,
      nutrients: nutrientTotals(
        supplements.filter((supplement) => {
          const { kind } = scheduleOn(supplement, from)
          return kind === 'dose' || kind === 'off'
        })
      ),
    },
  }
}
