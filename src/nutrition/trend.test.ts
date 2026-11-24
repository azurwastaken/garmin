import { describe, expect, it } from 'vitest'

import { addDays } from '../days.ts'

import { DEFAULT_PLAN, type Phase } from './plan.ts'
import {
  type BodyRow,
  dailyWeighIns,
  meanOn,
  slopePerWeek,
  statusOf,
  type Trend,
  trendOf,
  weightDays,
} from './trend.ts'

const START = '2026-11-19'

const row = (day: string, weight_kg: number, hour = '06'): BodyRow => ({
  time: `${day}T${hour}:40:00.000Z`,
  day,
  weight_kg,
  body_fat_pct: 18.8,
  muscle_mass_kg: 54.9,
})

// A weigh-in every `every` days from `from`, losing `perWeek` kg a week from 71
const series = (from: string, days: number, perWeek: number, every = 1) =>
  dailyWeighIns(
    Array.from({ length: Math.ceil(days / every) }, (_, index) =>
      row(addDays(from, index * every), 71 - (perWeek * index * every) / 7)
    )
  )

const deficit: Phase = { kind: 'deficit', from: START, to: '2027-01-31' }

describe('dailyWeighIns', () => {
  it('keeps the morning’s weigh-in of each day, in day order', () => {
    const weighIns = dailyWeighIns([
      row('2026-11-18', 71.1),
      row('2026-11-17', 72.4, '18'),
      row('2026-11-17', 71.8),
    ])
    expect(weighIns.map((weighIn) => [weighIn.day, weighIn.weight_kg])).toEqual([
      ['2026-11-17', 71.8],
      ['2026-11-18', 71.1],
    ])
  })
})

describe('meanOn', () => {
  const weighIns = dailyWeighIns([
    row('2026-11-13', 70),
    row('2026-11-16', 71),
    row('2026-11-18', 72),
  ])

  it('averages the 7 days ending the day, and needs 2 weigh-ins', () => {
    expect(meanOn(weighIns, '2026-11-18')).toBe(71)
    // 13/11 is out of the window ending 20/11
    expect(meanOn(weighIns, '2026-11-20')).toBe(71.5)
    expect(meanOn(weighIns, '2026-11-23')).toBeNull()
  })
})

describe('slopePerWeek', () => {
  it('fits a line through the days, in kg a week', () => {
    const points = [0, 7, 14].map((offset, index) => ({
      day: addDays(START, offset),
      value: 71 - 0.4 * index,
    }))
    expect(slopePerWeek(points)).toBeCloseTo(-0.4, 10)
    expect(slopePerWeek(points.slice(0, 1))).toBeNull()
    expect(slopePerWeek([])).toBeNull()
  })
})

describe('trendOf', () => {
  it('measures the slope over the last 28 days', () => {
    const today = addDays(START, 40)
    const trend = trendOf(series(START, 41, 0.4), today, START)
    expect(trend).toMatchObject({ kind: 'measured', from: addDays(today, -27), weigh_ins: 28 })
    expect(trend.kind === 'measured' && trend.kg_per_week).toBeCloseTo(-0.4, 2)
  })

  it('starts at the phase: the weeks before it are another regime', () => {
    // Gaining before the phase, losing 0.4 a week from its first day
    const before = Array.from({ length: 14 }, (_, index) =>
      row(addDays(START, index - 14), 70 + index * 0.05)
    )
    const after = Array.from({ length: 21 }, (_, index) =>
      row(addDays(START, index), 71 - (0.4 * index) / 7)
    )
    const trend = trendOf(dailyWeighIns([...before, ...after]), addDays(START, 20), START)
    expect(trend).toMatchObject({ kind: 'measured', from: START, weigh_ins: 21 })
    expect(trend.kind === 'measured' && trend.kg_per_week).toBeCloseTo(-0.4, 2)
  })

  it('says too few rather than draw a slope through a few weigh-ins', () => {
    // The real shape on 24/11: 5 weigh-ins in the 6 days before the deficit, 1 since
    const real = dailyWeighIns(
      [
        ['2026-11-13', 70.22],
        ['2026-11-14', 70.64],
        ['2026-11-16', 70.65],
        ['2026-11-17', 71.83],
        ['2026-11-18', 71.1],
        ['2026-11-24', 71.15],
      ].map(([day = '', kg = 0]) => row(String(day), Number(kg)))
    )
    expect(trendOf(real, '2026-11-24', START)).toEqual({
      kind: 'too-few',
      from: START,
      to: '2026-11-24',
      weigh_ins: 1,
    })
    // Means only from the phase's 7th day: 7 days of them, under 14
    expect(trendOf(series(START, 14, 0.4), addDays(START, 13), START).kind).toBe('too-few')
    // Means over 27 days, but only 3 weigh-ins in the window
    const today = '2026-12-20'
    const three = dailyWeighIns(
      [-30, -27, -6, 0].map((offset, index) => row(addDays(today, offset), 71 - index * 0.3))
    )
    expect(trendOf(three, today, '2026-09-01')).toMatchObject({ kind: 'too-few', weigh_ins: 3 })
  })
})

describe('statusOf', () => {
  const measured = (lossPerWeek: number): Trend => ({
    kind: 'measured',
    from: START,
    to: '2026-12-10',
    weigh_ins: 15,
    kg_per_week: -lossPerWeek,
  })
  const plan = DEFAULT_PLAN

  it('judges the loss with the plan’s thresholds', () => {
    const today = addDays(START, 21)
    const cases: ReadonlyArray<readonly [number, string]> = [
      [0.6, 'too-fast'],
      [0.51, 'too-fast'],
      [0.5, 'on-track'],
      [0.3, 'on-track'],
      [0.29, 'slow'],
      [0.1, 'slow'],
      [0.09, 'stalled'],
      [-0.2, 'stalled'],
    ]
    for (const [loss, status] of cases) {
      expect(statusOf(plan, deficit, measured(loss), today), String(loss)).toBe(status)
    }
  })

  it('calls nothing stalled before the phase is stall_after_days old', () => {
    expect(statusOf(plan, deficit, measured(0), addDays(START, 20))).toBe('slow')
    expect(statusOf(plan, deficit, measured(0), addDays(START, 21))).toBe('stalled')
    expect(
      statusOf({ ...plan, stall_after_days: 7 }, deficit, measured(0), addDays(START, 7))
    ).toBe('stalled')
  })

  it('says when there is no deficit to judge, or too few weigh-ins', () => {
    expect(statusOf(plan, null, measured(0.4), START)).toBe('no-phase')
    const maintenance: Phase = { kind: 'maintenance', from: '2027-02-01', to: '2027-04-11' }
    expect(statusOf(plan, maintenance, measured(0.9), '2027-02-10')).toBe('maintenance')
    const few: Trend = { kind: 'too-few', from: START, to: START, weigh_ins: 1 }
    expect(statusOf(plan, deficit, few, START)).toBe('too-few')
  })
})

describe('weightDays', () => {
  it('draws the corridor from the mean on the deficit’s first day', () => {
    const weighIns = dailyWeighIns([
      row('2026-11-16', 71),
      row('2026-11-18', 71.2),
      row('2026-12-03', 70.5),
    ])
    const days = weightDays(DEFAULT_PLAN, weighIns, '2026-11-18', '2026-12-03')
    expect(days).toHaveLength(16)
    expect(days[0]).toEqual({
      day: '2026-11-18',
      weight_kg: 71.2,
      body_fat_pct: 18.8,
      muscle_mass_kg: 54.9,
      mean: 71.1,
      lo: null,
      hi: null,
    })
    // The anchor 71.1 on 19/11; two weeks later, 0.6 to 1 kg under it
    expect(days.at(-1)).toMatchObject({ day: '2026-12-03', weight_kg: 70.5, lo: 70.1, hi: 70.5 })
    expect(days[1]).toMatchObject({ day: '2026-11-19', weight_kg: null, lo: 71.1, hi: 71.1 })
  })

  it('draws no corridor without a mean on the deficit’s first day', () => {
    const weighIns = dailyWeighIns([row('2026-11-01', 71), row('2026-11-25', 70.5)])
    const days = weightDays(DEFAULT_PLAN, weighIns, '2026-11-19', '2026-11-25')
    expect(days.every((day) => day.lo === null && day.hi === null)).toBe(true)
  })
})
