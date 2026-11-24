import { describe, expect, it } from 'vitest'

import { windowOf } from '../sleep-insights.ts'

import type { CaffeineRow, Instant } from './intake.ts'
import {
  bedtimeFrom,
  bedtimeOn,
  caffeineAt,
  CUTOFF_BEFORE_MS,
  curveOf,
  DEFAULT_BEDTIME_MIN,
  dailyHistory,
  todayView,
} from './kinetics.ts'

const at = (iso: string) => Date.parse(iso)
const row = (time: string, mg: number, day = time.slice(0, 10)): CaffeineRow => ({
  time: time as Instant,
  day,
  kind: 'filter',
  mg,
  note: null,
})

describe('the caffeine left', () => {
  // 100 mg at 18:30 Paris (17:30Z)
  const dose = { at: at('2026-11-24T17:30:00.000Z'), mg: 100 }

  it.each([
    ['at the dose', '2026-11-24T17:30:00.000Z', 100],
    ['one half-life on, at 23:30', '2026-11-24T22:30:00.000Z', 50],
    ['two half-lives on', '2026-11-25T03:30:00.000Z', 25],
    ['before it', '2026-11-24T17:29:59.999Z', 0],
  ])('is %s', (_, when, mg) => {
    expect(caffeineAt([dose], at(when))).toBeCloseTo(mg, 9)
  })

  it('adds the doses still there', () => {
    const morning = { at: at('2026-11-24T07:30:00.000Z'), mg: 200 }
    // 200 mg three half-lives back is 25 mg, plus 50
    expect(caffeineAt([morning, dose], at('2026-11-24T22:30:00.000Z'))).toBeCloseTo(75, 9)
  })
})

describe('the cut-off', () => {
  it('is h·log2(95/25) before bedtime: 9 h 37 min 48 s', () => {
    expect(CUTOFF_BEFORE_MS).toBe((9 * 3600 + 37 * 60 + 48) * 1000)
  })

  it.each([
    ['in winter', '2026-11-24', '2026-11-24T12:52:12.000Z'],
    ['in summer', '2026-07-01', '2026-07-01T11:52:12.000Z'],
  ])('is 13:52 in Paris %s', (_, day, iso) => {
    expect(bedtimeOn(day, DEFAULT_BEDTIME_MIN) - CUTOFF_BEFORE_MS).toBe(Date.parse(iso))
  })

  it('leaves 25 mg of a standard coffee at bedtime', () => {
    const bedtime = bedtimeOn('2026-11-24', DEFAULT_BEDTIME_MIN)
    const coffee = { at: bedtime - CUTOFF_BEFORE_MS, mg: 95 }
    expect(caffeineAt([coffee], bedtime)).toBeCloseTo(25, 3)
  })

  it.each([
    ['in winter (UTC+1)', '2026-11-24', '2026-11-24T22:30:00.000Z'],
    ['in summer (UTC+2)', '2026-07-01', '2026-07-01T21:30:00.000Z'],
    ['the day the clocks go forward', '2026-03-29', '2026-03-29T21:30:00.000Z'],
    ['the day they go back', '2026-10-25', '2026-10-25T22:30:00.000Z'],
  ])('puts bedtime at 23:30 Paris %s', (_, day, iso) => {
    expect(bedtimeOn(day, DEFAULT_BEDTIME_MIN)).toBe(at(iso))
  })
})

describe('the bedtime', () => {
  // Up at 06:30 after 7 h of sleep and 20 min awake: asleep by 23:10
  const window = windowOf({
    anchor: { kind: 'anchor', wake_min: 1110, mornings: 5 },
    plateau: { label: '7 h 00 – 7 h 30', sleep_s: 7 * 3600, nights: 5, score: 80, best_score: 80 },
    awake_s: 20 * 60,
    best: null,
  })

  it('is tonight’s advice when the sleep analysis has a plan', () => {
    expect(
      bedtimeFrom({
        kind: 'plan',
        window,
        debt: { target_s: 7 * 3600, nights: 7, debt_s: 3 * 3600 },
        tonight: {
          bed_min: window.bed_min - 30,
          wake_min: window.wake_min,
          earlier_min: 30,
          reasons: ['3 h 00 de dette sur les 7 dernières nuits'],
          sentence: '',
        },
      })
    ).toEqual({ bed_min: 640, source: { kind: 'tonight' } })
  })

  it('is 23:30 with too few nights, and says why', () => {
    const reason = 'Pas assez de nuits : 2 réveils en semaine sur les 5 qu’il faut.'
    expect(bedtimeFrom({ kind: 'too-few', missing: ['anchor'], mornings: 2, reason })).toEqual({
      bed_min: 690,
      source: { kind: 'default', reason },
    })
  })

  it.each([
    ['23:25, the same evening', '2026-11-24', 685, '2026-11-24T22:25:00.000Z'],
    ['00:30, the next calendar day', '2026-11-24', 750, '2026-11-24T23:30:00.000Z'],
    ['00:30 before the clocks go back at 03:00', '2026-10-24', 750, '2026-10-24T22:30:00.000Z'],
    [
      '02:30, skipped when the clocks go forward: 03:30',
      '2026-03-28',
      870,
      '2026-03-29T01:30:00.000Z',
    ],
  ])('puts %s', (_, day, bed_min, iso) => {
    expect(bedtimeOn(day, bed_min)).toBe(at(iso))
  })

  it('moves the cut-off with it: 14:52 for 00:30', () => {
    expect(bedtimeOn('2026-11-24', 750) - CUTOFF_BEFORE_MS).toBe(at('2026-11-24T13:52:12.000Z'))
  })
})

describe('the curve', () => {
  it('steps from its start and ends at its end', () => {
    const points = curveOf([{ at: 0, mg: 80 }], 0, 50 * 60_000, 15)
    expect(points.map((point) => point.at / 60_000)).toEqual([0, 15, 30, 45, 50])
    expect(points[0]?.mg).toBe(80)
  })
})

describe('today', () => {
  const bedtime = bedtimeOn('2026-11-24', DEFAULT_BEDTIME_MIN)
  const view = (now: string, recent: ReadonlyArray<CaffeineRow>) =>
    todayView({ today: '2026-11-24', now: at(now), bedtime, source: { kind: 'tonight' }, recent })

  it('counts today’s intakes, and yesterday’s evening in the body', () => {
    const today = view('2026-11-24T12:00:00.000Z', [
      // 23:00 yesterday in Paris
      row('2026-11-23T22:00:00.000Z', 100),
      // 08:00 and 11:00 today
      row('2026-11-24T07:00:00.000Z', 95),
      row('2026-11-24T10:00:00.000Z', 63),
    ])
    expect(today.intakes.map((intake) => [intake.clock, intake.mg])).toEqual([
      ['08:00', 95],
      ['11:00', 63],
    ])
    expect(today.total_mg).toBe(158)
    // 100·2^(−14/5) + 95·2^(−5/5) + 63·2^(−2/5) = 14.36 + 47.5 + 47.75
    expect(today.now_mg).toBe(110)
    // At 23:30: 100·2^(−24.5/5) + 95·2^(−15.5/5) + 63·2^(−12.5/5) = 3.36 + 11.08 + 11.14
    expect(today.bedtime_mg).toBe(26)
    expect(today.bedtime).toEqual({ at: '2026-11-24T22:30:00.000Z', clock: '23:30' })
    expect(today.cutoff).toEqual({ at: '2026-11-24T12:52:12.000Z', clock: '13:52' })
    expect(today.rule_cutoff).toEqual({ at: '2026-11-24T13:42:00.000Z', clock: '14:42' })
    expect(today.cutoff_passed).toBe(false)
    expect(today.over_day_limit).toBe(false)
    expect(today.strong).toEqual([])
  })

  it('says when the cut-off is behind, the day is over 400 mg and a dose over 200', () => {
    const today = view('2026-11-24T13:00:00.000Z', [
      row('2026-11-24T07:00:00.000Z', 200),
      row('2026-11-24T09:00:00.000Z', 201),
    ])
    expect(today.cutoff_passed).toBe(true)
    expect(today.over_day_limit).toBe(true)
    expect(today.strong.map((intake) => intake.mg)).toEqual([201])
  })

  it('is 400 mg at most without being over', () => {
    expect(
      view('2026-11-24T12:00:00.000Z', [
        row('2026-11-24T07:00:00.000Z', 200),
        row('2026-11-24T09:00:00.000Z', 200),
      ]).over_day_limit
    ).toBe(false)
  })
})

describe('the history', () => {
  it('sums each day and keeps its last intake’s time in Paris', () => {
    const rows = [
      row('2026-11-22T07:15:00.000Z', 63),
      row('2026-11-22T15:40:00.000Z', 95),
      // 00:30 on the 24th in Paris
      row('2026-11-23T23:30:00.000Z', 47, '2026-11-24'),
    ]
    expect(dailyHistory(rows, ['2026-11-22', '2026-11-23', '2026-11-24'])).toEqual([
      { day: '2026-11-22', mg: 158, count: 2, last_min: 16 * 60 + 40 },
      { day: '2026-11-23', mg: 0, count: 0, last_min: null },
      { day: '2026-11-24', mg: 47, count: 1, last_min: 30 },
    ])
  })
})
