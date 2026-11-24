import { describe, expect, it } from 'vitest'

import { addDays } from '../days.ts'

import { type PeakWeight, peakWeight } from './peak.ts'
import { DEFAULT_PLAN } from './plan.ts'
import { dailyWeighIns } from './trend.ts'

// Made-up weigh-ins: no real health data in the repository

const TODAY = '2026-11-24'
const DEFICIT = { kind: 'deficit', to: '2027-01-31' } as const

const weighIns = (rows: ReadonlyArray<readonly [day: string, kg: number, fat: number | null]>) =>
  dailyWeighIns(
    rows.map(([day, weight_kg, body_fat_pct]) => ({
      time: `${day}T06:00:00.000Z`,
      day,
      weight_kg,
      body_fat_pct,
      muscle_mass_kg: null,
    }))
  )

// `count` weigh-ins at 80 kg and 20 % fat, the last today
const steady = (count: number, fat: number | null = 20) =>
  weighIns(Array.from({ length: count }, (_, index) => [addDays(TODAY, -index), 80, fat] as const))

// The plan's target, from a window with a weigh-in
const targetOf = (result: PeakWeight) => {
  if (result.kind === 'no-weigh-in') throw new Error('no weigh-in')
  return result.target
}

const peak = (
  rows: ReturnType<typeof weighIns>,
  overrides: Partial<Parameters<typeof peakWeight>[0]> = {}
) =>
  peakWeight({
    plan: { target_kg: 75, loss_kg_per_week: { min: 0.3, max: 0.5 } },
    phase: DEFICIT,
    weighIns: rows,
    today: TODAY,
    ...overrides,
  })

describe('peakWeight', () => {
  it('carries the lean mass to 10–13 % fat, and to ±5 points of the scale’s error', () => {
    // 80 kg at 20 %: 64 kg lean, 71.11 kg at 10 %, 73.56 kg at 13 %; 60 or 68 kg lean if the
    // scale is 5 points off: 66.67 to 78.16 kg
    expect(peak(steady(3))).toMatchObject({
      kind: 'estimated',
      from: '2026-11-11',
      to: TODAY,
      weight_kg: 80,
      weigh_ins: { all: 3, with_fat: 3 },
      body_fat_pct: 20,
      lean_kg: 64,
      bia_kg: { min: 66.67, max: 78.16 },
      peak: {
        kind: 'dated',
        kg: { min: 71.11, max: 73.56 },
        gap_kg: { min: 6.44, max: 8.89 },
        // 6.44 kg at 0.5 kg a week: 12.9 weeks, 90.2 days, 91 rounded up
        fastest: { weeks: 12.9, by: addDays(TODAY, 91) },
        // 8.89 kg at 0.3 kg a week: 29.6 weeks, 207.4 days
        slowest: { weeks: 29.6, by: addDays(TODAY, 208) },
        deficit: 'after',
      },
      target: {
        kind: 'dated',
        kg: { min: 75, max: 75 },
        gap_kg: { min: 5, max: 5 },
        fastest: { weeks: 10, by: addDays(TODAY, 70) },
        slowest: { weeks: 16.7, by: addDays(TODAY, 117) },
        deficit: 'after',
      },
    })
  })

  it('needs 3 weigh-ins with a fat % in the window, and keeps the target without them', () => {
    const twoWithFat = weighIns([
      [TODAY, 80, 20],
      ['2026-11-23', 80, 20],
      ['2026-11-22', 82, null],
    ])
    expect(peak(twoWithFat)).toMatchObject({
      kind: 'too-few',
      // The mean of all three: the target's gap counts the weigh-in without a fat % too
      weight_kg: 80.67,
      weigh_ins: { all: 3, with_fat: 2 },
      target: { kind: 'dated', gap_kg: { min: 5.67, max: 5.67 } },
    })
    expect(peak(steady(3)).kind).toBe('estimated')
    expect(peak(steady(5, null))).toMatchObject({
      kind: 'too-few',
      weigh_ins: { all: 5, with_fat: 0 },
    })
  })

  it('counts the window’s first day, today − 13, and not the day before', () => {
    const edge = (first: string) =>
      peak(
        weighIns([
          [first, 80, 20],
          ['2026-11-20', 80, 20],
          [TODAY, 80, 20],
        ])
      ).kind
    expect(edge('2026-11-11')).toBe('estimated')
    expect(edge('2026-11-10')).toBe('too-few')
    expect(peak(weighIns([['2026-11-10', 80, 20]]))).toEqual({
      kind: 'no-weigh-in',
      from: '2026-11-11',
      to: TODAY,
    })
  })

  it('calls a goal reached inside its range or under it, and dated a step above', () => {
    const at = (kg: number) =>
      targetOf(
        peak(steady(3), {
          plan: { target_kg: kg, loss_kg_per_week: DEFAULT_PLAN.loss_kg_per_week },
        })
      )
    expect(at(80)).toMatchObject({ kind: 'reached', gap_kg: { min: 0, max: 0 } })
    expect(at(81)).toMatchObject({ kind: 'reached' })
    expect(at(79.99)).toMatchObject({ kind: 'dated', gap_kg: { min: 0.01, max: 0.01 } })
    // 65 kg at 11.4 % is 57.59 kg lean: its peak is 63.99–66.2 kg, and 65 kg sits inside it
    const inside = peakWeight({
      plan: DEFAULT_PLAN,
      phase: DEFICIT,
      weighIns: weighIns([
        [TODAY, 65, 11.4],
        ['2026-11-23', 65, 11.4],
        ['2026-11-22', 65, 11.4],
      ]),
      today: TODAY,
    })
    expect(inside).toMatchObject({ kind: 'estimated', peak: { kind: 'reached' } })
  })

  it('gives no date without a pace, and no slowest date when the slowest loss is 0', () => {
    expect(
      targetOf(peak(steady(3), { plan: { target_kg: 75, loss_kg_per_week: { min: 0, max: 0 } } }))
    ).toMatchObject({ kind: 'no-pace', gap_kg: { min: 5, max: 5 } })
    expect(
      targetOf(peak(steady(3), { plan: { target_kg: 75, loss_kg_per_week: { min: 0, max: 0.5 } } }))
    ).toMatchObject({ kind: 'dated', fastest: { weeks: 10 }, slowest: null })
  })

  it('places both dates, only the fastest or neither in the deficit, and nowhere outside one', () => {
    // 1 kg: at 0.5 kg a week 14 days, at 0.3 kg a week 23.3 days, 24 rounded up
    const by = (phase: Parameters<typeof peakWeight>[0]['phase']) =>
      targetOf(
        peak(steady(3), {
          plan: { target_kg: 79, loss_kg_per_week: { min: 0.3, max: 0.5 } },
          phase,
        })
      )
    expect(by({ kind: 'deficit', to: '2026-12-18' })).toMatchObject({
      fastest: { weeks: 2, by: '2026-12-08' },
      slowest: { weeks: 3.3, by: '2026-12-18' },
      deficit: 'within',
    })
    expect(by({ kind: 'deficit', to: '2026-12-17' })).toMatchObject({ deficit: 'fastest-only' })
    expect(by({ kind: 'deficit', to: '2026-12-08' })).toMatchObject({ deficit: 'fastest-only' })
    expect(by({ kind: 'deficit', to: '2026-12-07' })).toMatchObject({ deficit: 'after' })
    expect(by({ kind: 'maintenance', to: '2027-04-04' })).toMatchObject({ deficit: null })
    expect(by(null)).toMatchObject({ deficit: null })
  })
})
