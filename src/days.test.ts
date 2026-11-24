import { describe, expect, it } from 'vitest'

import { mondayOf, parisMinutesFromNoon } from './days.ts'

describe('mondayOf', () => {
  it('keeps a Monday and takes a Sunday back six days', () => {
    expect(mondayOf('2026-11-23')).toBe('2026-11-23')
    expect(mondayOf('2026-11-29')).toBe('2026-11-23')
    expect(mondayOf('2026-11-30')).toBe('2026-11-30')
  })
})

describe('parisMinutesFromNoon', () => {
  it.each([
    // Winter, UTC+1: 23:30Z is 00:30 in Paris
    ['2026-11-23T23:30:00.000Z', 750],
    ['2026-11-23T23:31:00.000Z', 751],
    // Summer, UTC+2: 22:30Z is 00:30 in Paris
    ['2026-07-01T22:30:00.000Z', 750],
    ['2026-07-01T22:31:00.000Z', 751],
    // Before midnight sorts before it
    ['2026-11-23T22:00:00.000Z', 660],
  ])('reads %s in Paris time as %i', (iso, minutes) => {
    expect(parisMinutesFromNoon(iso)).toBe(minutes)
  })

  it('has nothing to say of no instant or an unreadable one', () => {
    expect(parisMinutesFromNoon(null)).toBeNull()
    expect(parisMinutesFromNoon('hier soir')).toBeNull()
  })
})
