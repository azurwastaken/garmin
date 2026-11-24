import { Option } from 'effect'

import { minuteOf, parisInstant, parisWall } from '../days.ts'

import { type CaffeineRow, type Instant, instantOf } from './intake.ts'

// The caffeine in the body, estimated: first-order elimination with one half-life, a population
// mean, never the user's own (nothing here measures it). Instants are epoch ms; Paris wall times
// come in and go out through days.ts.

// EFSA 2015 (EFSA Journal 13(5):4102): a mean half-life of ~5 h in healthy adults, from ~2 to ~10 h
// (longer with oral contraceptives, in pregnancy, with liver disease; shorter for smokers)
export const HALF_LIFE_H = 5
// EFSA 2015: up to 400 mg a day, and 200 mg at once, raise no safety concern for a healthy adult
export const DAY_LIMIT_MG = 400
export const DOSE_LIMIT_MG = 200
// The cut-off: the latest a standard coffee (a 240 ml mug, ~95 mg) can be drunk and be down to
// ~25 mg at bedtime, about two half-lives
export const STANDARD_COFFEE_MG = 95
export const BEDTIME_LEFT_MG = 25
// Gardiner et al. 2023 (Sleep Medicine Reviews 69:101764, a meta-analysis): coffee at least 8.8 h
// before bed keeps its loss of total sleep time away
export const RULE_HOURS = 8.8

// TODO(jarvis-sleep): the sleep insights will recommend the bedtime; wire it in after that merge
export const TARGET_BEDTIME = '23:30'

const HOUR_MS = 3_600_000

export interface Dose {
  // Epoch ms
  readonly at: number
  readonly mg: number
}

export const doseFrom = (intake: { readonly time: string; readonly mg: number }): Dose => ({
  at: Date.parse(intake.time),
  mg: intake.mg,
})

// The caffeine left at `at`: every dose taken by then, halved each HALF_LIFE_H
export const caffeineAt = (doses: ReadonlyArray<Dose>, at: number) =>
  doses
    .filter((dose) => dose.at <= at)
    .reduce((sum, dose) => sum + dose.mg * 0.5 ** ((at - dose.at) / (HALF_LIFE_H * HOUR_MS)), 0)

// How long before bedtime a standard coffee is down to BEDTIME_LEFT_MG: h·log2(95/25), 9 h 37 min
// 48 s, to the second
export const CUTOFF_BEFORE_MS =
  Math.round(HALF_LIFE_H * 3600 * Math.log2(STANDARD_COFFEE_MG / BEDTIME_LEFT_MG)) * 1000

// The estimate every `stepMin` minutes from `from`, and at `to`
export const curveOf = (doses: ReadonlyArray<Dose>, from: number, to: number, stepMin: number) => {
  const step = stepMin * 60_000
  return Array.from({ length: Math.ceil((to - from) / step) + 1 }, (_, index) =>
    Math.min(from + index * step, to)
  ).map((at) => ({ at, mg: caffeineAt(doses, at) }))
}

// The target bedtime on a day (23:30 always exists in Paris: the clocks change at night)
export const bedtimeOn = (day: string) => Option.getOrThrow(parisInstant(day, TARGET_BEDTIME))

// An instant and its Paris wall clock, as the activities pair start_time and start_local
export interface Moment {
  readonly at: Instant
  readonly clock: string
}

export const momentOf = (ms: number): Moment => ({ at: instantOf(ms), clock: parisWall(ms).clock })

export interface TodayIntake extends CaffeineRow {
  // HH:MM in Paris
  readonly clock: string
}

export interface CaffeineToday {
  readonly today: string
  // Today's (Paris), by time
  readonly intakes: ReadonlyArray<TodayIntake>
  readonly total_mg: number
  readonly over_day_limit: boolean
  // Those over DOSE_LIMIT_MG at once
  readonly strong: ReadonlyArray<TodayIntake>
  // Estimates
  readonly now_mg: number
  readonly bedtime: Moment
  readonly bedtime_mg: number
  // The last standard coffee for ≤ 25 mg at bedtime (the one the pages show), and whether it is
  // behind now; the meta-analysis's rule beside it
  readonly cutoff: Moment
  readonly cutoff_passed: boolean
  readonly rule_cutoff: Moment
}

// Today from the recent rows (from yesterday on: last night's coffee still counts now), by time
export const todayView = (input: {
  readonly today: string
  readonly now: number
  readonly bedtime: number
  readonly recent: ReadonlyArray<CaffeineRow>
}): CaffeineToday => {
  const doses = input.recent.map(doseFrom)
  const intakes = input.recent
    .filter((row) => row.day === input.today)
    .map((row) => Object.assign(row, { clock: parisWall(Date.parse(row.time)).clock }))
  const total = intakes.reduce((sum, intake) => sum + intake.mg, 0)
  const cutoff = input.bedtime - CUTOFF_BEFORE_MS
  return {
    today: input.today,
    intakes,
    total_mg: Math.round(total),
    over_day_limit: total > DAY_LIMIT_MG,
    strong: intakes.filter((intake) => intake.mg > DOSE_LIMIT_MG),
    now_mg: Math.round(caffeineAt(doses, input.now)),
    bedtime: momentOf(input.bedtime),
    bedtime_mg: Math.round(caffeineAt(doses, input.bedtime)),
    cutoff: momentOf(cutoff),
    cutoff_passed: input.now > cutoff,
    rule_cutoff: momentOf(input.bedtime - RULE_HOURS * HOUR_MS),
  }
}

export interface CaffeineDay {
  readonly day: string
  readonly mg: number
  readonly count: number
  // The last intake, in minutes after midnight (Paris)
  readonly last_min: number | null
}

// Each day's caffeine from the rows, by time: its total, how many, the last one's time
export const dailyHistory = (
  rows: ReadonlyArray<CaffeineRow>,
  days: ReadonlyArray<string>
): Array<CaffeineDay> =>
  days.map((day) => {
    const of = rows.filter((row) => row.day === day)
    const last = of.at(-1)
    return {
      day,
      mg: Math.round(of.reduce((sum, row) => sum + row.mg, 0)),
      count: of.length,
      last_min: last === undefined ? null : minuteOf(parisWall(Date.parse(last.time)).clock),
    }
  })
