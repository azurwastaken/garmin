import { describe, expect, it } from 'vitest'

import { measureFraction, shownLimit } from './gauge.ts'

// HRV: worse below its normal; resting HR: worse above it
const hrv = (value: number) => ({ value, normal: 40, limit: 36 })
const resting = (value: number) => ({ value, normal: 54, limit: 57 })

describe('measureFraction', () => {
  it('puts the normal at the middle and the limit at a quarter', () => {
    expect(measureFraction(hrv(40))).toBe(0.5)
    expect(measureFraction(hrv(36))).toBe(0.25)
    expect(measureFraction(resting(54))).toBe(0.5)
    expect(measureFraction(resting(57))).toBe(0.25)
  })

  it('runs toward 0 when worse and toward 1 when better, clamped', () => {
    expect(measureFraction(hrv(32))).toBe(0)
    expect(measureFraction(hrv(28))).toBe(0)
    expect(measureFraction(hrv(44))).toBe(0.75)
    expect(measureFraction(hrv(52))).toBe(1)
    expect(measureFraction(resting(60))).toBe(0)
    expect(measureFraction(resting(63))).toBe(0)
    expect(measureFraction(resting(51))).toBe(0.75)
    expect(measureFraction(resting(45))).toBe(1)
  })
})

describe('shownLimit', () => {
  it('rounds to 0.1 away from the normal, an exact limit kept', () => {
    expect(shownLimit({ limit: 54.036, normal: 51 })).toBe(54.1)
    expect(shownLimit({ limit: 36.964, normal: 40 })).toBe(36.9)
    expect(shownLimit({ limit: 57, normal: 54 })).toBe(57)
  })
})
