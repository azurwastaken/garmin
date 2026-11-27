import { describe, expect, it } from 'vitest'

import { type Lever, type LeverFacts, leversOf, leverWindows } from './levers.ts'
import { DEFAULT_PLAN } from './plan.ts'

// Made-up facts: no real health data in the repository

const TODAY = '2026-11-24'
const WINDOWS = leverWindows(TODAY)

// 28 nights of 7 h asleep at 23:30 in Paris (22:30Z in winter)
const nights = (count: number, sleep_s: number | null = 7 * 3600, start = '22:30') =>
  Array.from({ length: count }, (_, index) => ({
    sleep_s,
    sleep_start: `2026-11-${String(index + 1).padStart(2, '0')}T${start}:00.000Z`,
  }))

const FACTS: LeverFacts = {
  active_days: 12,
  strength_sessions: 16,
  running_km: 8 * 30,
  steps: Array.from({ length: 28 }, () => 10_000),
  nights: nights(28),
}

const WEIGHT = { kg: 70, from: '2026-11-11', to: TODAY }

const levers = (
  facts: Partial<LeverFacts> = {},
  weight: Parameters<typeof leversOf>[0]['weight'] = WEIGHT
) => leversOf({ facts: { ...FACTS, ...facts }, windows: WINDOWS, plan: DEFAULT_PLAN, weight })

const lever = (key: Lever['key'], ...args: Parameters<typeof levers>) => {
  const found = levers(...args).find((candidate) => candidate.key === key)
  if (found === undefined) throw new Error(`no ${key}`)
  return found
}

describe('leverWindows', () => {
  it('takes the 28 days before today, the 28 nights to this morning, the 8 full weeks before this one', () => {
    // A Tuesday
    expect(leverWindows('2026-11-24')).toEqual({
      days: { from: '2026-10-27', to: '2026-11-23' },
      nights: { from: '2026-10-28', to: '2026-11-24' },
      weeks: { from: '2026-09-28', to: '2026-11-22' },
    })
    // A Monday's week is its own: the 8 weeks end the day before
    expect(leverWindows('2026-11-23').weeks).toEqual({ from: '2026-09-28', to: '2026-11-22' })
    // A Sunday is still in the week begun 6 days earlier
    expect(leverWindows('2026-11-29').weeks).toEqual({ from: '2026-09-28', to: '2026-11-22' })
  })
})

describe('the levers', () => {
  it('counts the rest days, untracked, with the plan’s rest-day kcal', () => {
    expect(lever('rest-days')).toMatchObject({
      status: 'untracked',
      measured: { value: 16, unit: 'jours sans séance', from: '2026-10-27', to: '2026-11-23' },
      kcal_per_day: null,
      text: expect.stringMatching(/^16 jours sans séance sur 28 : à 1 900 kcal.*environ 39 g/u),
    })
  })

  it('gives the breakfast swap its saving, with nothing measured', () => {
    expect(lever('breakfast')).toMatchObject({
      status: 'untracked',
      measured: null,
      kcal_per_day: { min: 200, max: 300 },
    })
  })

  it('gives the batch cooking, the frozen vegetables and the snack their facts, untracked', () => {
    const untracked = { status: 'untracked', measured: null, kcal_per_day: null }
    expect(lever('batch-cooking')).toMatchObject({
      ...untracked,
      text: expect.stringMatching(/2 × 45 min.*2 de tes 4 déjeuners au bureau/u),
    })
    expect(lever('frozen-veg')).toMatchObject({
      ...untracked,
      text: expect.stringMatching(/environ 8 min.*2 à 3 fois par semaine à la place des pâtes/u),
    })
    expect(lever('snack')).toMatchObject({
      ...untracked,
      text: expect.stringMatching(
        /vers 17–18 h.*pas en plus des kcal du jour.*au moins 2 h avant/u
      ),
    })
  })

  it('judges the plan’s protein per kg: room under 1.8 g/kg, above past 2.2, none without a weight', () => {
    // 130 g: 1.8 g/kg at 72.2 kg, under it a kg heavier
    expect(lever('protein', {}, { kg: 72.2, from: TODAY, to: TODAY })).toMatchObject({
      status: 'fine',
      measured: { value: 1.8, unit: 'g/kg', from: TODAY, to: TODAY },
      text: expect.stringContaining('Les apports ne sont pas suivis'),
    })
    const under = lever('protein', {}, { kg: 73.2, from: TODAY, to: TODAY })
    expect(under).toMatchObject({ status: 'room', measured: { value: 1.78 } })
    expect(under.text).toContain('sous la fourchette')
    expect(under.text).not.toContain('vise le haut')
    // In the range up to 2.2 g/kg, with the advice; past it, above the range and no advice to eat more
    const top = lever('protein', {}, { kg: 59, from: TODAY, to: TODAY })
    expect(top).toMatchObject({ status: 'fine', measured: { value: 2.2 } })
    expect(top.text).toContain('dans la fourchette')
    expect(top.text).toContain('vise le haut les jours durs')
    const above = lever('protein', {}, { kg: 58.9, from: TODAY, to: TODAY })
    expect(above).toMatchObject({ status: 'fine', measured: { value: 2.21 } })
    expect(above.text).toContain('au-dessus de la fourchette')
    expect(above.text).not.toContain('vise le haut')
    expect(lever('protein', {}, null)).toMatchObject({ status: 'no-data', measured: null })
  })

  it('wants 2 strength sessions a week over the weeks given', () => {
    expect(lever('strength', { strength_sessions: 16 })).toMatchObject({
      status: 'fine',
      measured: { value: 16, unit: 'séances', from: '2026-09-28', to: '2026-11-22' },
    })
    expect(lever('strength', { strength_sessions: 15 })).toMatchObject({
      status: 'room',
      text: expect.stringMatching(/^15 séances de renforcement en 8 semaines, pour 16 attendues/u),
    })
  })

  it('compares running km a week with a first marathon plan’s first week, and burns the difference', () => {
    expect(lever('running', { running_km: 8 * 24 })).toMatchObject({
      status: 'fine',
      measured: { value: 24, unit: 'km/sem.' },
      kcal_per_day: null,
    })
    // 23.9 km a week: 0.1 km short, 75 kcal/km ÷ 7 days
    expect(lever('running', { running_km: 8 * 23.9 })).toMatchObject({
      status: 'room',
      measured: { value: 23.9 },
      kcal_per_day: { min: 1, max: 1 },
    })
    // 10 km a week: 14 km short, 150 kcal a day
    expect(lever('running', { running_km: 80 })).toMatchObject({
      kcal_per_day: { min: 150, max: 150 },
      text: expect.stringContaining('au plus, pour le genou'),
    })
  })

  it('compares steps with 10 000 a day, 100 kcal per 2 000 missing, none without a day', () => {
    expect(lever('steps', { steps: [10_000, 10_000] })).toMatchObject({
      status: 'fine',
      measured: { value: 10_000, unit: 'pas/jour', from: '2026-10-27', to: '2026-11-23' },
    })
    expect(lever('steps', { steps: [9_999, 9_999] })).toMatchObject({ status: 'room' })
    expect(lever('steps', { steps: [8_000, 8_000] })).toMatchObject({
      kcal_per_day: { min: 100, max: 100 },
    })
    expect(lever('steps', { steps: [] })).toMatchObject({ status: 'no-data', measured: null })
  })

  it('wants 7 h of sleep and at most one night a week after 00:30', () => {
    expect(lever('sleep')).toMatchObject({
      status: 'fine',
      measured: { value: 7, unit: 'h', from: '2026-10-28', to: TODAY },
      text: expect.stringMatching(/^7 h 00 de sommeil en moyenne sur 28 nuits, 0 coucher après/u),
    })
    expect(lever('sleep', { nights: nights(28, 7 * 3600 - 60) })).toMatchObject({ status: 'room' })
    // 4 of 28 after 00:30 is one a week: still fine; 5 is more
    const late = (count: number) => [...nights(count, 7 * 3600, '23:31'), ...nights(28 - count)]
    expect(lever('sleep', { nights: late(4) })).toMatchObject({ status: 'fine' })
    expect(lever('sleep', { nights: late(5) })).toMatchObject({
      status: 'room',
      text: expect.stringContaining('5 couchers après 00 h 30 sur 28 nuits'),
    })
    // 00:30 itself is not after 00:30
    expect(lever('sleep', { nights: nights(28, 7 * 3600, '23:30') })).toMatchObject({
      status: 'fine',
    })
  })

  it('says the bedtimes are unknown rather than judge them, and has nothing without a night', () => {
    const noBedtime = nights(28).map((night) => Object.assign(night, { sleep_start: null }))
    expect(lever('sleep', { nights: noBedtime })).toMatchObject({
      status: 'fine',
      text: expect.stringContaining('heures de coucher inconnues'),
    })
    expect(lever('sleep', { nights: nights(28, null) })).toMatchObject({
      status: 'no-data',
      measured: null,
    })
  })

  it('reads the window lengths from the windows', () => {
    const fortnight = {
      days: { from: '2026-11-10', to: '2026-11-23' },
      nights: { from: '2026-11-11', to: TODAY },
      weeks: { from: '2026-11-09', to: '2026-11-22' },
    }
    const short = leversOf({
      facts: { ...FACTS, active_days: 4, strength_sessions: 4, running_km: 48 },
      windows: fortnight,
      plan: DEFAULT_PLAN,
      weight: null,
    })
    expect(short.find((each) => each.key === 'rest-days')?.measured?.value).toBe(10)
    expect(short.find((each) => each.key === 'strength')).toMatchObject({ status: 'fine' })
    expect(short.find((each) => each.key === 'running')?.measured?.value).toBe(24)
  })

  it('ranks room first, then untracked, then fine, then no-data, the biggest effect first', () => {
    const ranked = levers(
      { strength_sessions: 0, running_km: 80, steps: [8_000], nights: nights(28, null) },
      null
    )
    expect(ranked.map((each) => [each.key, each.status])).toEqual([
      // running 150 kcal a day, steps 100, strength none
      ['running', 'room'],
      ['steps', 'room'],
      ['strength', 'room'],
      // breakfast 300 kcal a day, the others none, in the order they are built
      ['breakfast', 'untracked'],
      ['rest-days', 'untracked'],
      ['batch-cooking', 'untracked'],
      ['frozen-veg', 'untracked'],
      ['snack', 'untracked'],
      ['protein', 'no-data'],
      ['sleep', 'no-data'],
    ])
  })
})
