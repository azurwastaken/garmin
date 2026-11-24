import { addDays } from '../days.ts'
import { mean, round } from '../numbers.ts'

import type { NutritionPlan, Phase } from './plan.ts'
import type { DailyWeighIns } from './trend.ts'

// The peak weight, without I/O: the lean mass of the last 14 days' weigh-ins (weight × (1 − fat %))
// carried to a runner's body-fat range, assuming the lean mass is kept, then how long it takes at
// the plan's pace; and the plan's own target the same way. The scale's fat % is bio-impedance:
// the range under its error is given too, never a single number.

export const LEAN_WINDOW_DAYS = 14
export const MIN_LEAN_WEIGH_INS = 3
// A male endurance runner's body fat (%): the upper part of ACE's "athletes" band for men (6–13 %),
// kept above its lower part for a recreational marathoner; its min is the health floor too
export const RUNNER_BODY_FAT_PCT = { min: 10, max: 13 }
// A foot-to-foot impedance scale's fat %, against MRI and DXA: 95 % limits of agreement of about
// ±5 points and more (Bosy-Westphal et al., Obes Facts 2008)
export const BIA_ERROR_POINTS = 5

interface Range {
  readonly min: number
  readonly max: number
}

// within: both dates before the deficit ends; fastest-only: only the fastest (or no slowest
// date at all); after: even the fastest comes after it
export type DeficitFit = 'within' | 'fastest-only' | 'after'

export type Goal = { readonly kg: Range; readonly gap_kg: Range } &
  // The weight is inside the range or under it
  (
    | { readonly kind: 'reached' }
    // The plan aims at no loss: no date at any pace
    | { readonly kind: 'no-pace' }
    | {
        readonly kind: 'dated'
        // At the plan's fastest loss, to the range's near end
        readonly fastest: { readonly weeks: number; readonly by: string }
        // At its slowest, to the far end; null when its slowest loss is 0
        readonly slowest: { readonly weeks: number; readonly by: string } | null
        // Where the dates fall against the current deficit phase's end; null outside one
        readonly deficit: DeficitFit | null
      }
  )

// The window's weigh-ins: all of them, and those with a fat %
export interface WeighInCount {
  readonly all: number
  readonly with_fat: number
}

// From the window's weigh-ins (from = today − 13, to = today): none; too few with a fat % for the
// peak; or the peak estimated. weight_kg is the mean of all of them, the base of both goals' gaps;
// target is the plan's own (kg.min = kg.max)
export type PeakWeight = { readonly from: string; readonly to: string } & (
  | { readonly kind: 'no-weigh-in' }
  | {
      readonly kind: 'too-few'
      readonly weight_kg: number
      readonly target: Goal
      readonly weigh_ins: WeighInCount
    }
  | {
      readonly kind: 'estimated'
      readonly weight_kg: number
      readonly target: Goal
      readonly weigh_ins: WeighInCount
      // The means of the weigh-ins with a fat %
      readonly body_fat_pct: number
      readonly lean_kg: number
      // The peak range if the scale's fat % is off by BIA_ERROR_POINTS either way
      readonly bia_kg: Range
      // The long-term range, at RUNNER_BODY_FAT_PCT
      readonly peak: Goal
    }
)

type Loss = NutritionPlan['loss_kg_per_week']

// Whole days to cover `weeks`, rounded up: a goal takes at least that long (a float's last digit
// never adds a day)
const daysFor = (weeks: number) => Math.ceil(Number((weeks * 7).toFixed(6)))

// Where a goal's fastest and slowest dates fall against the deficit's last day
const deficitFit = (fastest: string, slowest: string | null, end: string): DeficitFit => {
  if (fastest > end) return 'after'
  return slowest !== null && slowest <= end ? 'within' : 'fastest-only'
}

// How far `weight` is from a range and when the plan's pace gets there, from today
const goalOf = (
  kg: Range,
  weight: number,
  loss: Loss,
  phase: Pick<Phase, 'kind' | 'to'> | null,
  today: string
): Goal => {
  const gap = {
    min: round(Math.max(0, weight - kg.max), 2) ?? 0,
    max: round(Math.max(0, weight - kg.min), 2) ?? 0,
  }
  if (gap.min === 0) return { kind: 'reached', kg, gap_kg: gap }
  if (loss.max === 0) return { kind: 'no-pace', kg, gap_kg: gap }
  const at = (gapKg: number, kgPerWeek: number) => {
    const weeks = gapKg / kgPerWeek
    return { weeks: round(weeks, 1) ?? 0, by: addDays(today, daysFor(weeks)) }
  }
  const fastest = at(gap.min, loss.max)
  const slowest = loss.min === 0 ? null : at(gap.max, loss.min)
  return {
    kind: 'dated',
    kg,
    gap_kg: gap,
    fastest,
    slowest,
    deficit:
      phase?.kind === 'deficit' ? deficitFit(fastest.by, slowest?.by ?? null, phase.to) : null,
  }
}

// The weight a body-fat percentage gives with this lean mass
const atFat = (leanKg: number, fatPct: number) => leanKg / (1 - fatPct / 100)

// The peak weight from the last 14 days' weigh-ins, and the plan's target, each with its gap and
// the dates the plan's pace gives
export const peakWeight = (input: {
  readonly plan: Pick<NutritionPlan, 'target_kg' | 'loss_kg_per_week'>
  // Today's phase
  readonly phase: Pick<Phase, 'kind' | 'to'> | null
  readonly weighIns: DailyWeighIns
  readonly today: string
}): PeakWeight => {
  const { plan, phase, weighIns, today } = input
  const from = addDays(today, -(LEAN_WINDOW_DAYS - 1))
  const window = weighIns.filter((weighIn) => weighIn.day >= from && weighIn.day <= today)
  const weight = round(mean(window.map((weighIn) => weighIn.weight_kg)), 2)
  if (weight === null) return { kind: 'no-weigh-in', from, to: today }
  const withFat = window.flatMap(({ weight_kg, body_fat_pct }) =>
    body_fat_pct === null ? [] : [{ weight_kg, fat: body_fat_pct }]
  )
  const known = {
    from,
    to: today,
    weight_kg: weight,
    target: goalOf(
      { min: plan.target_kg, max: plan.target_kg },
      weight,
      plan.loss_kg_per_week,
      phase,
      today
    ),
    weigh_ins: { all: window.length, with_fat: withFat.length },
  }
  if (withFat.length < MIN_LEAN_WEIGH_INS) return { kind: 'too-few', ...known }
  const lean = mean(withFat.map((weighIn) => weighIn.weight_kg * (1 - weighIn.fat / 100))) ?? 0
  // The lean mass if the true fat % were BIA_ERROR_POINTS higher or lower
  const leanShift =
    ((mean(withFat.map((weighIn) => weighIn.weight_kg)) ?? 0) * BIA_ERROR_POINTS) / 100
  const peakKg = {
    min: round(atFat(lean, RUNNER_BODY_FAT_PCT.min), 2) ?? 0,
    max: round(atFat(lean, RUNNER_BODY_FAT_PCT.max), 2) ?? 0,
  }
  return {
    kind: 'estimated',
    ...known,
    body_fat_pct: round(mean(withFat.map((weighIn) => weighIn.fat)), 2) ?? 0,
    lean_kg: round(lean, 2) ?? 0,
    bia_kg: {
      min: round(atFat(lean - leanShift, RUNNER_BODY_FAT_PCT.min), 2) ?? 0,
      max: round(atFat(lean + leanShift, RUNNER_BODY_FAT_PCT.max), 2) ?? 0,
    },
    peak: goalOf(peakKg, weight, plan.loss_kg_per_week, phase, today),
  }
}
