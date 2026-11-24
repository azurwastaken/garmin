import { describe, expect, it } from 'vitest'

import { median, spread } from './numbers.ts'

describe('number helpers', () => {
  it.each([
    { values: [], expected: null },
    { values: [7], expected: 7 },
    { values: [3, 1, 2], expected: 2 },
    { values: [4, 1, 3, 2], expected: 2.5 },
  ])('takes the median of $values', ({ values, expected }) => {
    expect(median(values)).toBe(expected)
  })

  it.each([
    { values: [], expected: null },
    { values: [5], expected: null },
    { values: [1, 3], expected: 1 },
    { values: [2, 4, 4, 4, 5, 5, 7, 9], expected: 2 },
  ])('takes the population standard deviation of $values', ({ values, expected }) => {
    expect(spread(values)).toBe(expected)
  })
})
