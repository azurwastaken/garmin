import { describe, expect, it } from 'vitest'

import type { CaffeineRow, Instant } from './intake.ts'
import {
  bedtimeOn,
  caffeineAt,
  CUTOFF_BEFORE_MS,
  curveOf,
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

  it('leaves 25 mg of a standard coffee at bedtime', () => {
    const bedtime = bedtimeOn('2026-11-24')
    const coffee = { at: bedtime - CUTOFF_BEFORE_MS, mg: 95 }
    expect(caffeineAt([coffee], bedtime)).toBeCloseTo(25, 3)
  })

  it.each([
    ['in winter (UTC+1)', '2026-11-24', '2026-11-24T22:30:00.000Z'],
    ['in summer (UTC+2)', '2026-07-01', '2026-07-01T21:30:00.000Z'],
    ['the day the clocks go forward', '2026-03-29', '2026-03-29T21:30:00.000Z'],
    ['the day they go back', '2026-10-25', '2026-10-25T22:30:00.000Z'],
  ])('puts bedtime at 23:30 Paris %s', (_, day, iso) => {
    expect(bedtimeOn(day)).toBe(at(iso))
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
  const bedtime = bedtimeOn('2026-11-24')
  const view = (now: string, recent: ReadonlyArray<CaffeineRow>) =>
    todayView({ today: '2026-11-24', now: at(now), bedtime, recent })

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
