import { Option } from 'effect'

import { clock } from '../components/format.ts'
import { addDays, minuteOf, parisInstant, parisWall } from '../days.ts'
import type { Plan } from '../sleep-insights.ts'

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

// The bedtime without enough nights for the sleep analysis: 23:30, on the noon axis
export const DEFAULT_BEDTIME_MIN = 690

// The coach's line for one night (not a study's): under 6.5 h, last night was short. Not the
// levers' SLEEP_MIN_H (7 h, a 28-night average) nor the sleep analysis's SHORT_NIGHT_S (an hour
// under the user's own window): this one judges the single night ending this morning
export const SHORT_NIGHT_H = 6.5
// From this many intakes today a short night warns: short night, more coffee, later bedtime
export const SHORT_NIGHT_INTAKES = 2
// Al Khatib et al. 2017 (Eur J Clin Nutr 71:614–624, a meta-analysis): partial sleep restriction
// raises energy intake by about 385 kcal a day
export const SHORT_SLEEP_EXTRA_KCAL = 385
// Daylight within the hour after waking advances the body clock: the coach's dose, minutes outside
export const MORNING_LIGHT_MIN = { min: 10, max: 20 }

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

// Where tonight's bedtime comes from: the sleep analysis's advice, or 23:30 and why
export type BedtimeSource =
  | { readonly kind: 'tonight' }
  | { readonly kind: 'default'; readonly reason: string }

export interface Bedtime {
  // Asleep by, on the noon axis (minutes from noon the day before, Paris time: 00:30 is 750)
  readonly bed_min: number
  readonly source: BedtimeSource
}

// Tonight's bedtime from the sleep analysis's plan, 23:30 when it has too few nights
export const bedtimeFrom = (plan: Plan): Bedtime =>
  plan.kind === 'plan'
    ? { bed_min: plan.tonight.bed_min, source: { kind: 'tonight' } }
    : { bed_min: DEFAULT_BEDTIME_MIN, source: { kind: 'default', reason: plan.reason } }

// The instant of a bedtime on the evening of `day`: from midnight on (720), the next calendar day.
// Every wall time exists in Paris: one the clocks skip moves later, on the same day
export const bedtimeOn = (day: string, bed_min: number) =>
  Option.getOrThrow(parisInstant(bed_min >= 720 ? addDays(day, 1) : day, clock(bed_min)))

// An instant and its Paris wall clock, as the activities pair start_time and start_local
export interface Moment {
  readonly at: Instant
  readonly clock: string
}

export const momentOf = (ms: number): Moment => ({ at: instantOf(ms), clock: parisWall(ms).clock })

// Last night (daily.day is today: the night ending this morning) against SHORT_NIGHT_H; unknown
// before the watch has synced it
export type ShortNight =
  | { readonly kind: 'unknown' }
  | { readonly kind: 'fine'; readonly sleep_h: number }
  | { readonly kind: 'short'; readonly sleep_h: number; readonly warning: boolean }

// Last night's sleep and today's intakes: the warning from SHORT_NIGHT_INTAKES on a short night.
// sleep_h is floored to the hundredth, so a short night never reads 6.5
export const shortNightOf = (sleepS: number | null, intakes: number): ShortNight => {
  if (sleepS === null) return { kind: 'unknown' }
  const sleepH = Math.floor(sleepS / 36) / 100
  return sleepS < SHORT_NIGHT_H * 3600
    ? { kind: 'short', sleep_h: sleepH, warning: intakes >= SHORT_NIGHT_INTAKES }
    : { kind: 'fine', sleep_h: sleepH }
}

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
  readonly bedtime_source: BedtimeSource
  readonly bedtime_mg: number
  // The last standard coffee for ≤ 25 mg at bedtime (the one the pages show), and whether it is
  // behind now; the meta-analysis's rule beside it
  readonly cutoff: Moment
  readonly cutoff_passed: boolean
  readonly rule_cutoff: Moment
  readonly short_night: ShortNight
}

// Today from the recent rows, by time (the days before still count in the body)
export const todayView = (input: {
  readonly today: string
  readonly now: number
  readonly bedtime: number
  readonly source: BedtimeSource
  readonly recent: ReadonlyArray<CaffeineRow>
  // Last night's sleep (daily.sleep_s), null before the watch syncs it
  readonly night_s: number | null
}): CaffeineToday => {
  const doses = input.recent.map(doseFrom)
  const intakes = input.recent
    .filter((row) => row.day === input.today)
    .map((row) => ({ ...row, clock: parisWall(Date.parse(row.time)).clock }))
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
    bedtime_source: input.source,
    bedtime_mg: Math.round(caffeineAt(doses, input.bedtime)),
    cutoff: momentOf(cutoff),
    cutoff_passed: input.now > cutoff,
    rule_cutoff: momentOf(input.bedtime - RULE_HOURS * HOUR_MS),
    short_night: shortNightOf(input.night_s, intakes.length),
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
