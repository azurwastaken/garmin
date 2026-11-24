import { Schema } from 'effect'

// The nutrition plan agreed with the coach, without I/O: data/nutrition/plan.json (the source of
// truth, as every file of data/), read on each request and never copied into SQLite, as the races.
// Without the file, the plan agreed on 2026-11-16.

// Its own helpers, as races/race.ts and journal/note.ts: this module must not load the API's
const Day = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/u))
const Text = (max: number) => Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(max))
const Between = (min: number, max: number) =>
  Schema.Finite.check(Schema.isGreaterThanOrEqualTo(min), Schema.isLessThanOrEqualTo(max))
const Kcal = Schema.Int.check(Schema.isBetween({ minimum: 500, maximum: 6000 }))
const Range = (min: number, max: number) =>
  Schema.Struct({ min: Between(min, max), max: Between(min, max) }).check(
    Schema.makeFilter((range) => range.min <= range.max || 'min ≤ max')
  )

export const DAY_TYPES = ['rest', 'easy', 'quality', 'long'] as const
export type DayType = (typeof DAY_TYPES)[number]

export const PLAN_PATH = 'nutrition/plan.json'

const PhaseJson = Schema.Struct({
  kind: Schema.Literals(['deficit', 'maintenance']),
  from: Day,
  // Its last day, included
  to: Day,
  // What ends it (a race)
  label: Schema.optionalKey(Text(120)),
}).check(Schema.makeFilter((phase) => phase.from <= phase.to || 'phase : from ≤ to'))

export const NutritionPlanJson = Schema.Struct({
  agreed: Day.annotate({ description: 'The day it was agreed, YYYY-MM-DD' }),
  kcal: Schema.Struct({ rest: Kcal, easy: Kcal, quality: Kcal, long: Kcal }).annotate({
    description: 'kcal to eat on a day of each type',
  }),
  long_run_carbs_g_per_h: Range(0, 150).annotate({
    description: 'Carbs per hour during the run, on a long day (g)',
  }),
  protein_g: Between(0, 400).annotate({ description: 'Protein a day, whatever the day (g)' }),
  loss_kg_per_week: Range(0, 2).annotate({
    description: 'The loss aimed for in a deficit phase (kg a week): above max, too fast',
  }),
  stall_kg_per_week: Between(0, 2).annotate({
    description: 'Below this loss (kg a week), stalled once the phase is stall_after_days old',
  }),
  stall_after_days: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 365 })),
  target_kg: Between(30, 250),
  phases: Schema.Array(PhaseJson).annotate({
    description: 'deficit or maintenance, from and to (included), in date order, never overlapping',
  }),
}).check(
  Schema.makeFilter(
    (plan) =>
      plan.phases.every((phase, index) => (plan.phases[index - 1]?.to ?? '') < phase.from) ||
      'phases : dans l’ordre des dates, sans chevauchement'
  )
)
export type NutritionPlan = typeof NutritionPlanJson.Type
export type Phase = NutritionPlan['phases'][number]

export const DEFAULT_PLAN: NutritionPlan = {
  agreed: '2026-11-16',
  kcal: { rest: 1900, easy: 2600, quality: 2850, long: 3400 },
  long_run_carbs_g_per_h: { min: 40, max: 60 },
  protein_g: 130,
  loss_kg_per_week: { min: 0.3, max: 0.5 },
  stall_kg_per_week: 0.1,
  stall_after_days: 21,
  target_kg: 68,
  phases: [
    { kind: 'deficit', from: '2026-11-19', to: '2027-01-31' },
    // shortcut: the Paris Marathon's date is assumed (no race file for it), set_nutrition_plan
    // fixes it
    { kind: 'maintenance', from: '2027-02-01', to: '2027-04-11', label: 'Marathon de Paris' },
  ],
}

// The phase `day` falls in, null outside every phase
export const phaseOn = (phases: ReadonlyArray<Phase>, day: string): Phase | null =>
  phases.find((phase) => phase.from <= day && day <= phase.to) ?? null

export interface DayTarget {
  readonly kcal: number
  readonly protein_g: number
  // Only on a long day
  readonly run_carbs_g_per_h: { readonly min: number; readonly max: number } | null
}

// What the plan asks of a day of that type: its kcal, the protein, carbs during a long day's run
export const targetFor = (
  plan: Pick<NutritionPlan, 'kcal' | 'protein_g' | 'long_run_carbs_g_per_h'>,
  type: DayType
): DayTarget => ({
  kcal: plan.kcal[type],
  protein_g: plan.protein_g,
  run_carbs_g_per_h: type === 'long' ? plan.long_run_carbs_g_per_h : null,
})
