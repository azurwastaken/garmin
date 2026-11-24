import { addDays } from '../days.ts'
import { mean, present } from '../numbers.ts'

import type { CaffeineRow } from './intake.ts'
import { caffeineAt, doseFrom } from './kinetics.ts'

// Caffeine against the night that followed: the estimate at the night's sleep onset (Garmin's, the
// only one in the data: the time it took to fall asleep is not there) and the last intake before
// it, beside the sleep score, the HRV, the resting HR and the deep sleep. Two groups, more than
// HIGH_MG left or not; nothing is said under MIN_NIGHTS a side. It is an association, never a cause.

export const HIGH_MG = 50
export const MIN_NIGHTS = 10

const DAY_MS = 86_400_000

export interface NightRow {
  // The morning it ended (daily.day)
  readonly day: string
  readonly sleep_start: string
  readonly sleep_score: number | null
  readonly hrv: number | null
  readonly resting_hr: number | null
  readonly deep_s: number | null
}

export interface CaffeineNight extends NightRow {
  // The estimate at sleep_start
  readonly left_mg: number
  // The last intake in the 24 h before it
  readonly last_intake: string | null
}

// The nights fully tracked, with their caffeine: from the first intake's day + 2 (that day's
// earlier coffees were not logged; its night is the next morning's)
export const caffeineNights = (
  rows: ReadonlyArray<CaffeineRow>,
  nights: ReadonlyArray<NightRow>
): Array<CaffeineNight> => {
  const first = rows[0]
  if (first === undefined) return []
  const doses = rows.map((row) => doseFrom(row))
  return nights
    .filter((night) => night.day > addDays(first.day, 1))
    .map((night) => {
      const onset = Date.parse(night.sleep_start)
      const last = rows.findLast((row) => {
        const at = Date.parse(row.time)
        return at <= onset && at > onset - DAY_MS
      })
      return Object.assign(night, {
        left_mg: Math.round(caffeineAt(doses, onset)),
        last_intake: last?.time ?? null,
      })
    })
}

export type MetricKey = 'sleep_score' | 'hrv' | 'resting_hr' | 'deep_min'

export type MetricGap =
  | {
      readonly kind: 'too-few'
      readonly key: MetricKey
      readonly high_n: number
      readonly low_n: number
    }
  | {
      readonly kind: 'compared'
      readonly key: MetricKey
      readonly high: { readonly n: number; readonly mean: number }
      readonly low: { readonly n: number; readonly mean: number }
      // high − low
      readonly diff: number
    }

export type CaffeineVsSleep =
  | {
      readonly kind: 'too-few'
      readonly high: number
      readonly low: number
      readonly needed: number
    }
  | {
      readonly kind: 'compared'
      readonly high: number
      readonly low: number
      readonly metrics: ReadonlyArray<MetricGap>
    }

const METRICS: ReadonlyArray<{
  readonly key: MetricKey
  readonly value: (night: CaffeineNight) => number | null
}> = [
  { key: 'sleep_score', value: (night) => night.sleep_score },
  { key: 'hrv', value: (night) => night.hrv },
  { key: 'resting_hr', value: (night) => night.resting_hr },
  { key: 'deep_min', value: (night) => (night.deep_s === null ? null : night.deep_s / 60) },
]

const tenth = (value: number) => Math.round(value * 10) / 10

// One measure's means in both groups, from the nights that have it
const gapOf = (
  metric: (typeof METRICS)[number],
  high: ReadonlyArray<CaffeineNight>,
  low: ReadonlyArray<CaffeineNight>
): MetricGap => {
  const highValues = present(high.map((night) => metric.value(night)))
  const lowValues = present(low.map((night) => metric.value(night)))
  const highMean = mean(highValues)
  const lowMean = mean(lowValues)
  return highValues.length < MIN_NIGHTS ||
    lowValues.length < MIN_NIGHTS ||
    highMean === null ||
    lowMean === null
    ? { kind: 'too-few', key: metric.key, high_n: highValues.length, low_n: lowValues.length }
    : {
        kind: 'compared',
        key: metric.key,
        high: { n: highValues.length, mean: tenth(highMean) },
        low: { n: lowValues.length, mean: tenth(lowMean) },
        diff: tenth(highMean - lowMean),
      }
}

// The nights with more than HIGH_MG left at sleep onset against the others
export const compareNights = (nights: ReadonlyArray<CaffeineNight>): CaffeineVsSleep => {
  const high = nights.filter((night) => night.left_mg > HIGH_MG)
  const low = nights.filter((night) => night.left_mg <= HIGH_MG)
  return high.length < MIN_NIGHTS || low.length < MIN_NIGHTS
    ? { kind: 'too-few', high: high.length, low: low.length, needed: MIN_NIGHTS }
    : {
        kind: 'compared',
        high: high.length,
        low: low.length,
        metrics: METRICS.map((metric) => gapOf(metric, high, low)),
      }
}
