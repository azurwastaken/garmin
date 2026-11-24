import { describe, expect, it } from 'vitest'

import { addDays } from '../days.ts'

import type { CaffeineRow, Instant } from './intake.ts'
import { type CaffeineNight, caffeineNights, compareNights, type NightRow } from './sleep.ts'

const row = (time: string, mg: number): CaffeineRow => ({
  time: time as Instant,
  day: time.slice(0, 10),
  kind: 'filter',
  mg,
  note: null,
})

const night = (day: string, start: string): NightRow => ({
  day,
  sleep_start: start,
  sleep_score: 80,
  hrv: 45,
  resting_hr: 50,
  deep_s: 5400,
})

describe('the nights and their caffeine', () => {
  const rows = [
    // The first intake: 08:00 Paris on the 10th
    row('2026-11-10T07:00:00.000Z', 95),
    // 18:30 Paris on the 11th, 100 mg
    row('2026-11-11T17:30:00.000Z', 100),
  ]

  it('starts from the first fully tracked night', () => {
    const nights = [
      night('2026-11-10', '2026-11-09T22:30:00.000Z'),
      night('2026-11-11', '2026-11-10T22:30:00.000Z'),
      night('2026-11-12', '2026-11-11T22:30:00.000Z'),
    ]
    expect(caffeineNights(rows, nights).map((n) => n.day)).toEqual(['2026-11-12'])
  })

  it('keeps the caffeine at sleep onset and the last intake within 24 h', () => {
    const [linked] = caffeineNights(rows, [night('2026-11-12', '2026-11-11T22:30:00.000Z')])
    // 100 mg one half-life back, plus 95 mg 39.5 h back (95·2^(−7.9) = 0.41)
    expect(linked?.left_mg).toBe(50)
    expect(linked?.last_intake).toBe('2026-11-11T17:30:00.000Z')
    const [later] = caffeineNights(rows, [night('2026-11-14', '2026-11-13T22:30:00.000Z')])
    expect(later?.last_intake).toBeNull()
    expect(later?.left_mg).toBe(0)
  })

  it('has nothing to say without an intake', () => {
    expect(caffeineNights([], [night('2026-11-12', '2026-11-11T22:30:00.000Z')])).toEqual([])
  })
})

// `count` nights with `left_mg` left, their measures from `measures`
const nights = (
  count: number,
  left_mg: number,
  measures: Partial<CaffeineNight> = {}
): Array<CaffeineNight> =>
  Array.from({ length: count }, (_, index) => ({
    ...night(addDays('2026-01-01', index), '2026-01-01T22:00:00.000Z'),
    left_mg,
    last_intake: null,
    ...measures,
  }))

describe('the comparison', () => {
  it('says nothing under 10 nights a side', () => {
    expect(compareNights([...nights(9, 80), ...nights(30, 10)])).toEqual({
      kind: 'too-few',
      high: 9,
      low: 30,
      needed: 10,
    })
  })

  it('puts 50 mg in the low group and compares the means', () => {
    const result = compareNights([
      ...nights(5, 51, { sleep_score: 70, hrv: 40 }),
      ...nights(5, 90, { sleep_score: 72, hrv: 42 }),
      ...nights(12, 50, { sleep_score: 82, hrv: 48, deep_s: null }),
    ])
    expect(result).toEqual({
      kind: 'compared',
      high: 10,
      low: 12,
      metrics: [
        {
          kind: 'compared',
          key: 'sleep_score',
          high: { n: 10, mean: 71 },
          low: { n: 12, mean: 82 },
          diff: -11,
        },
        {
          kind: 'compared',
          key: 'hrv',
          high: { n: 10, mean: 41 },
          low: { n: 12, mean: 48 },
          diff: -7,
        },
        {
          kind: 'compared',
          key: 'resting_hr',
          high: { n: 10, mean: 50 },
          low: { n: 12, mean: 50 },
          diff: 0,
        },
        // Deep sleep is missing on the low side: not compared
        { kind: 'too-few', key: 'deep_min', high_n: 10, low_n: 0 },
      ],
    })
  })
})
