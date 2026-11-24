import { Schema } from 'effect'
import { describe, expect, it } from 'vitest'

import {
  nutrientTotals,
  scheduleOn,
  type Supplement,
  SupplementsJson,
  supplementsOn,
} from './supplements.ts'

// Made-up products: no real health data in the repository

const daily = (overrides: Partial<Supplement> = {}): Supplement => ({
  name: 'Magnésium test',
  brand: 'Marque A',
  unit_name: 'gélule',
  intakes: [
    { moment: 'lunch', units: 1 },
    { moment: 'dinner', units: 1 },
  ],
  serving_units: 2,
  contents: [{ nutrient: 'magnesium', amount: 200, unit: 'mg', form: 'bisglycinate' }],
  every_days: 1,
  start: '2026-11-01',
  ...overrides,
})

const everyOther = daily({
  name: 'D3 test',
  brand: 'Marque B',
  intakes: [{ moment: 'dinner', units: 1 }],
  serving_units: 1,
  contents: [
    { nutrient: 'vitamin_d', amount: 100, unit: 'µg' },
    { nutrient: 'vitamin_k2', amount: 0.1, unit: 'mg', form: 'MK-7' },
  ],
  every_days: 2,
  start: '2026-11-26',
})

const decode = Schema.decodeUnknownResult(SupplementsJson)
const refused = (supplement: unknown) => decode({ supplements: [supplement] })._tag === 'Failure'

describe('the supplements file', () => {
  it('decodes a list, and nothing at all', () => {
    const list = { supplements: [daily(), everyOther] }
    expect(decode(JSON.parse(JSON.stringify(list)))).toMatchObject({
      _tag: 'Success',
      success: list,
    })
    expect(decode({ supplements: [] })._tag).toBe('Success')
  })

  it('refuses a stop before its start, a moment twice, no intake, an unknown unit', () => {
    expect(refused(daily({ stop: '2026-10-31' }))).toBe(true)
    expect(refused(daily({ stop: '2026-11-01' }))).toBe(false)
    expect(
      refused(
        daily({
          intakes: [
            { moment: 'dinner', units: 1 },
            { moment: 'dinner', units: 1 },
          ],
        })
      )
    ).toBe(true)
    expect(refused(daily({ intakes: [] }))).toBe(true)
    expect(
      refused({ ...daily(), contents: [{ nutrient: 'vitamin_d', amount: 5600, unit: 'IU' }] })
    ).toBe(true)
    expect(
      refused({ ...daily(), contents: [{ nutrient: 'Vitamine D', amount: 1, unit: 'µg' }] })
    ).toBe(true)
  })
})

describe('scheduleOn', () => {
  const rhythm = { start: '2026-11-26', stop: '2026-12-01', every_days: 2 }

  it.each([
    ['2026-11-25', { kind: 'upcoming', next: '2026-11-26' }],
    ['2026-11-26', { kind: 'dose', next: '2026-11-28' }],
    ['2026-11-27', { kind: 'off', next: '2026-11-28' }],
    ['2026-11-28', { kind: 'dose', next: '2026-11-30' }],
    // Its stop is a day it is still taken on; the next dose would fall after it
    ['2026-11-30', { kind: 'dose', next: null }],
    ['2026-12-01', { kind: 'off', next: null }],
    ['2026-12-02', { kind: 'stopped' }],
  ] as const)('on %s: %o', (day, schedule) => {
    expect(scheduleOn(rhythm, day)).toEqual(schedule)
  })

  it('makes every day of a daily one a dose day, with tomorrow next', () => {
    expect(scheduleOn(daily(), '2026-11-24')).toEqual({ kind: 'dose', next: '2026-11-25' })
  })
})

describe('nutrientTotals', () => {
  it('averages a day: units a day over the serving, over the rhythm', () => {
    // 2 units a day of a 2-unit serving: 200 mg; one unit every other day: 50 µg and 0.05 mg
    expect(nutrientTotals([daily(), everyOther])).toEqual([
      expect.objectContaining({ nutrient: 'magnesium', per_day: 200, unit: 'mg', status: 'under' }),
      expect.objectContaining({ nutrient: 'vitamin_d', per_day: 50, unit: 'µg', status: 'under' }),
      {
        nutrient: 'vitamin_k2',
        per_day: 0.05,
        unit: 'mg',
        caution: null,
        status: 'no-limit',
        limit: null,
      },
    ])
  })

  it('sums µg and mg in the limit’s unit, under at the limit and over past it', () => {
    const atLimit = daily({
      contents: [
        { nutrient: 'magnesium', amount: 249.9, unit: 'mg' },
        { nutrient: 'magnesium', amount: 100, unit: 'µg' },
      ],
    })
    expect(nutrientTotals([atLimit])).toMatchObject([
      { nutrient: 'magnesium', per_day: 250, unit: 'mg', status: 'under' },
    ])
    const past = daily({ contents: [{ nutrient: 'magnesium', amount: 0.251, unit: 'g' }] })
    expect(nutrientTotals([past])).toMatchObject([
      {
        nutrient: 'magnesium',
        per_day: 251,
        status: 'over',
        limit: { amount: 250, scope: 'supplements' },
      },
    ])
  })

  it('gives a nutrient without a limit its first unit, and its caution when there is one', () => {
    const extract = daily({
      contents: [
        { nutrient: 'ashwagandha', amount: 0.6, unit: 'g' },
        { nutrient: 'taurine', amount: 300, unit: 'mg' },
      ],
    })
    expect(nutrientTotals([extract])).toEqual([
      expect.objectContaining({
        nutrient: 'ashwagandha',
        per_day: 0.6,
        unit: 'g',
        status: 'no-limit',
        caution: expect.stringMatching(/^Pas de limite officielle\. ANSES 2024/u),
      }),
      expect.objectContaining({ nutrient: 'taurine', per_day: 300, unit: 'mg', caution: null }),
    ])
  })
})

describe('supplementsOn', () => {
  it('groups today’s doses by moment, keeps a later start for later, and averages once it starts', () => {
    const day = supplementsOn([daily(), everyOther], '2026-11-24')
    expect(day.moments).toEqual([
      {
        moment: 'lunch',
        take: [{ name: 'Magnésium test', brand: 'Marque A', units: 1, unit_name: 'gélule' }],
      },
      {
        moment: 'dinner',
        take: [{ name: 'Magnésium test', brand: 'Marque A', units: 1, unit_name: 'gélule' }],
      },
    ])
    expect(day.items.map((item) => item.schedule)).toEqual([
      { kind: 'dose', next: '2026-11-25' },
      { kind: 'upcoming', next: '2026-11-26' },
    ])
    expect(day.totals.from).toBe('2026-11-26')
    expect(day.totals.nutrients.map((total) => total.nutrient)).toEqual([
      'magnesium',
      'vitamin_d',
      'vitamin_k2',
    ])
  })

  it('averages from today when everything has started, and leaves out an off day’s intakes', () => {
    const day = supplementsOn([daily(), everyOther], '2026-11-27')
    expect(day.totals.from).toBe('2026-11-27')
    expect(day.moments.flatMap((moment) => moment.take.map((take) => take.name))).toEqual([
      'Magnésium test',
      'Magnésium test',
    ])
    expect(day.items[1]?.schedule).toEqual({ kind: 'off', next: '2026-11-28' })
  })

  it('drops a stopped supplement, and one that stops before a later start from the averages', () => {
    const stopped = daily({ name: 'Ancien', stop: '2026-11-20' })
    const stopsSoon = daily({ name: 'Bientôt fini', stop: '2026-11-25' })
    const day = supplementsOn([stopped, stopsSoon, everyOther], '2026-11-24')
    expect(day.items.map((item) => item.name)).toEqual(['Bientôt fini', 'D3 test'])
    // From the 26th, the magnesium has stopped: only the D3 counts
    expect(day.totals.nutrients.map((total) => total.nutrient)).toEqual(['vitamin_d', 'vitamin_k2'])
  })
})
