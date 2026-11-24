import { describe, expect, it } from 'vitest'

import { mondayOf, placeSessions, type WeekDay } from './schedule.ts'

const WEEK = '2026-11-30'

const day = (date: string, change: Partial<WeekDay> = {}): WeekDay => ({
  day: date,
  type: 'rest',
  reason: 'rien de prévu ni de fait',
  calendar: [],
  strength: false,
  ...change,
})
const quality = (date: string, name = 'Plan - VMA') =>
  day(date, { type: 'quality', reason: '« VMA » dans la séance', calendar: [name] })
const long = (date: string) =>
  day(date, { type: 'long', reason: '90 min de course prévus', calendar: ['Plan - Long 90'] })
const easy = (date: string) =>
  day(date, { type: 'easy', reason: 'séance prévue sans intensité', calendar: ['Plan - EF 40'] })

const place = (days: ReadonlyArray<WeekDay>, today = '2026-11-29', target = 2) =>
  placeSessions({ week: WEEK, today, days, target, minDaysApart: 2 })
const daysOf = (placement: ReturnType<typeof place>) => placement.slots.map((slot) => slot.day)

describe('placing the week', () => {
  it('spreads two sessions over an empty week, as early as the widest gap allows', () => {
    const placement = place([])
    expect(daysOf(placement)).toEqual(['2026-11-30', '2026-12-03'])
    expect(placement.slots[0]).toMatchObject({
      type: 'rest',
      reason: 'jour sans course',
      warning: null,
    })
    expect(placement.missing).toBe(0)
  })

  it('never the day before a quality session or a long run, nor the long run’s day', () => {
    const placement = place([quality('2026-12-02'), long('2026-12-06')])
    expect(placement.rejected).toEqual([
      { day: '2026-12-01', why: 'veille d’une séance de qualité (« VMA » dans la séance)' },
      { day: '2026-12-05', why: 'veille de la sortie longue (90 min de course prévus)' },
      { day: '2026-12-06', why: 'sortie longue ce jour-là (90 min de course prévus)' },
    ])
    expect(daysOf(placement)).not.toContain('2026-12-01')
    expect(daysOf(placement)).not.toContain('2026-12-05')
  })

  it('prefers the quality day (after the session), then an easy day, then a day without a run', () => {
    const placement = place([easy('2026-12-01'), quality('2026-12-03'), easy('2026-12-05')])
    expect(daysOf(placement)).toEqual(['2026-12-01', '2026-12-03'])
    expect(placement.slots[1]?.reason).toBe(
      'après la séance de qualité (« VMA » dans la séance) : jours durs durs, jours faciles faciles'
    )
    // A run already in the calendar that day: the coach is told before the push
    expect(placement.slots[1]?.warning).toContain('« Plan - VMA » déjà au calendrier ce jour-là')
  })

  it('keeps 48 h from another strength session, the Sunday before included', () => {
    const placement = place([
      day('2026-11-29', { strength: true }),
      day('2026-12-03', { strength: true }),
    ])
    expect(placement.already).toEqual(['2026-12-03'])
    expect(daysOf(placement)).toHaveLength(1)
    expect(placement.rejected).toContainEqual({
      day: '2026-11-30',
      why: 'moins de 48 h du renfo du 2026-11-29',
    })
    for (const slot of placement.slots) {
      expect(['2026-11-30', '2026-12-02', '2026-12-03', '2026-12-04']).not.toContain(slot.day)
    }
  })

  it('counts the week’s sessions already there towards the target', () => {
    const placement = place([
      day('2026-12-01', { strength: true }),
      day('2026-12-04', { strength: true }),
    ])
    expect(placement).toMatchObject({
      already: ['2026-12-01', '2026-12-04'],
      slots: [],
      missing: 0,
    })
  })

  it('never in the past, and says what the week could not take', () => {
    const placement = place([], '2026-12-05')
    expect(daysOf(placement)).toEqual(['2026-12-05'])
    expect(placement.missing).toBe(1)
    expect(placement.rejected.filter((r) => r.why === 'passé')).toHaveLength(5)
  })

  it('looks at the Monday after for Sunday', () => {
    const placement = place([quality('2026-12-07')], '2026-12-06', 1)
    expect(placement.rejected).toContainEqual({
      day: '2026-12-06',
      why: 'veille d’une séance de qualité (« VMA » dans la séance)',
    })
    expect(placement).toMatchObject({ slots: [], missing: 1 })
  })
})

describe('weeks', () => {
  it('starts on Monday', () => {
    expect(mondayOf('2026-11-30')).toBe('2026-11-30')
    expect(mondayOf('2026-12-06')).toBe('2026-11-30')
    expect(mondayOf('2026-12-01')).toBe('2026-11-30')
  })
})
