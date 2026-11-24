import { Brand } from 'effect'

import { addDays, daysBetween } from '../days.ts'
import { mean, round } from '../numbers.ts'

import type { NutritionPlan, Phase } from './plan.ts'

// The weight trend, without I/O: one weigh-in a day, its 7-day mean, the mean's slope over the
// last 28 days of the phase, and what the plan says of it. Few weigh-ins make no slope: the trend
// says so rather than draw a line through two points.

export interface BodyRow {
  readonly time: string
  readonly day: string
  readonly weight_kg: number
  readonly body_fat_pct: number | null
  readonly muscle_mass_kg: number | null
}

export interface WeighIn {
  readonly day: string
  readonly weight_kg: number
  readonly body_fat_pct: number | null
  readonly muscle_mass_kg: number | null
}

// Weigh-ins, one a day in day order: only dailyWeighIns makes one
export type DailyWeighIns = ReadonlyArray<WeighIn> & Brand.Brand<'DailyWeighIns'>
const makeDaily = Brand.nominal<DailyWeighIns>()

const MEAN_DAYS = 7
const MIN_IN_MEAN = 2
const SLOPE_DAYS = 28
// What a slope takes (the page says so too)
export const MIN_SLOPE_SPAN_DAYS = 14
export const MIN_SLOPE_WEIGH_INS = 4

// The morning's weigh-in of each day (its earliest), in day order: Withings and Garmin may both have
// one
export const dailyWeighIns = (rows: ReadonlyArray<BodyRow>): DailyWeighIns => {
  const first = new Map<string, WeighIn>()
  for (const { time: _time, ...weighIn } of rows.toSorted((a, b) => a.time.localeCompare(b.time))) {
    if (!first.has(weighIn.day)) first.set(weighIn.day, weighIn)
  }
  return makeDaily([...first.values()].toSorted((a, b) => a.day.localeCompare(b.day)))
}

// Every day from `from` to `to`
const daysOf = (from: string, to: string) =>
  Array.from({ length: Math.max(0, daysBetween(from, to) + 1) }, (_, index) => addDays(from, index))

// The mean of the weigh-ins of the 7 days ending `day`; null with fewer than 2
export const meanOn = (weighIns: DailyWeighIns, day: string): number | null => {
  const from = addDays(day, -(MEAN_DAYS - 1))
  const window = weighIns.filter((weighIn) => weighIn.day >= from && weighIn.day <= day)
  return window.length < MIN_IN_MEAN ? null : mean(window.map((weighIn) => weighIn.weight_kg))
}

// The least-squares slope of the values against their days, in kg a week; null under 2 days
export const slopePerWeek = (
  points: ReadonlyArray<{ readonly day: string; readonly value: number }>
): number | null => {
  const [first] = points
  if (first === undefined) return null
  const xs = points.map((point) => daysBetween(first.day, point.day))
  const xMean = mean(xs) ?? 0
  const yMean = mean(points.map((point) => point.value)) ?? 0
  const sxx = xs.reduce((sum, x) => sum + (x - xMean) ** 2, 0)
  if (sxx === 0) return null
  const sxy = points.reduce(
    (sum, point, index) => sum + ((xs[index] ?? 0) - xMean) * (point.value - yMean),
    0
  )
  return (sxy / sxx) * 7
}

export type Trend =
  // The window: from–to; weigh_ins, those inside it
  | {
      readonly kind: 'too-few'
      readonly from: string
      readonly to: string
      readonly weigh_ins: number
    }
  | {
      readonly kind: 'measured'
      readonly from: string
      readonly to: string
      readonly weigh_ins: number
      // Negative: losing
      readonly kg_per_week: number
    }

// The slope of the 7-day mean over the 28 days ending today, from `since` at the earliest (the
// phase's start). Only means whose 7 days are all in the phase count: the weeks before it are
// another regime, and a mean cut at its start moves at half the pace. It takes 4 weigh-ins in the
// window and means over 14 days or more
export const trendOf = (weighIns: DailyWeighIns, today: string, since: string | null): Trend => {
  const start = addDays(today, -(SLOPE_DAYS - 1))
  const from = since !== null && since > start ? since : start
  const inside = weighIns.filter((weighIn) => weighIn.day >= from && weighIn.day <= today).length
  const firstFull = since === null ? from : addDays(since, MEAN_DAYS - 1)
  const means = daysOf(firstFull > from ? firstFull : from, today).flatMap((day) => {
    const value = meanOn(weighIns, day)
    return value === null ? [] : [{ day, value }]
  })
  const span =
    means.length === 0 ? 0 : daysBetween(means[0]?.day ?? today, means.at(-1)?.day ?? today)
  const slope = slopePerWeek(means)
  return inside < MIN_SLOPE_WEIGH_INS || span < MIN_SLOPE_SPAN_DAYS || slope === null
    ? { kind: 'too-few', from, to: today, weigh_ins: inside }
    : { kind: 'measured', from, to: today, weigh_ins: inside, kg_per_week: round(slope, 2) ?? 0 }
}

export type Status =
  | 'no-phase'
  | 'maintenance'
  | 'too-few'
  | 'too-fast'
  | 'on-track'
  | 'slow'
  | 'stalled'

// The trend against the plan, in the phase that clipped it: too fast past its max loss, on track
// from its min, stalled under its stall loss once the phase is old enough, else slow
export const statusOf = (
  plan: Pick<NutritionPlan, 'loss_kg_per_week' | 'stall_kg_per_week' | 'stall_after_days'>,
  phase: Phase | null,
  trend: Trend,
  today: string
): Status => {
  if (phase === null) return 'no-phase'
  if (phase.kind === 'maintenance') return 'maintenance'
  if (trend.kind === 'too-few') return 'too-few'
  const loss = -trend.kg_per_week
  if (loss > plan.loss_kg_per_week.max) return 'too-fast'
  if (loss >= plan.loss_kg_per_week.min) return 'on-track'
  return loss < plan.stall_kg_per_week && daysBetween(phase.from, today) >= plan.stall_after_days
    ? 'stalled'
    : 'slow'
}

export interface WeightDay {
  readonly day: string
  readonly weight_kg: number | null
  readonly body_fat_pct: number | null
  readonly muscle_mass_kg: number | null
  readonly mean: number | null
  // The corridor, in a deficit phase: the most (lo) and the least (hi) the plan's loss leads to
  readonly lo: number | null
  readonly hi: number | null
}

// Each day from `from` to `to`: its weigh-in, its 7-day mean and, in a deficit phase, the corridor
// (the 7-day mean on the phase's first day, minus the plan's loss a week); no corridor for a phase
// without that mean
export const weightDays = (
  plan: Pick<NutritionPlan, 'loss_kg_per_week' | 'phases'>,
  weighIns: DailyWeighIns,
  from: string,
  to: string
): Array<WeightDay> => {
  const byDay = new Map(weighIns.map((weighIn) => [weighIn.day, weighIn]))
  const anchored = plan.phases.flatMap((phase) => {
    const anchor = phase.kind === 'deficit' ? meanOn(weighIns, phase.from) : null
    return anchor === null ? [] : [{ phase, anchor }]
  })
  return daysOf(from, to).map((day) => {
    const weighIn = byDay.get(day)
    const deficit = anchored.find(({ phase }) => phase.from <= day && day <= phase.to)
    const weeks = deficit === undefined ? 0 : daysBetween(deficit.phase.from, day) / 7
    return {
      day,
      weight_kg: weighIn?.weight_kg ?? null,
      body_fat_pct: weighIn?.body_fat_pct ?? null,
      muscle_mass_kg: weighIn?.muscle_mass_kg ?? null,
      mean: round(meanOn(weighIns, day), 2),
      lo:
        deficit === undefined ? null : round(deficit.anchor - plan.loss_kg_per_week.max * weeks, 2),
      hi:
        deficit === undefined ? null : round(deficit.anchor - plan.loss_kg_per_week.min * weeks, 2),
    }
  })
}
