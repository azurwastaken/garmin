import { Option } from 'effect'
import { describe, expect, it } from 'vitest'

import { instantOf } from '../caffeine/intake.ts'

import { decodeMeal, MEAL_KINDS, MEAL_LABELS, mealPath, mealRows } from './meal.ts'

const meal = { time: '2026-11-24T19:30:00.000Z', kind: 'dinner' }

describe('the meal kinds', () => {
  it('label every kind once, in the tuple the schema takes', () => {
    expect([...MEAL_KINDS].toSorted()).toEqual(Object.keys(MEAL_LABELS).toSorted())
  })
})

describe('a meal file', () => {
  it('decodes, with or without its note', () => {
    expect(decodeMeal(meal)).toEqual(Option.some(meal))
    expect(decodeMeal({ ...meal, note: 'restau' })).toEqual(
      Option.some({ ...meal, note: 'restau' })
    )
  })

  it.each([
    ['an unknown kind', { kind: 'brunch' }],
    ['a time without milliseconds', { time: '2026-11-24T19:30:00Z' }],
    ['a path for a time', { time: '../../etc/passwd' }],
    ['an empty note', { note: '' }],
    ['a note over 200 characters', { note: 'x'.repeat(201) }],
  ])('refuses %s', (_, change) => {
    expect(Option.isNone(decodeMeal({ ...meal, ...change }))).toBe(true)
  })

  it('is named by its time, without colons', () => {
    expect(mealPath(instantOf(Date.parse(meal.time)))).toBe(
      'meals/2026/2026-11-24T19-30-00.000Z.json'
    )
  })
})

describe('the rows from the files', () => {
  // Named by its time; its content that meal at that time unless given
  const file = (time: string, json?: unknown) => ({
    path: `meals/${time.slice(0, 4)}/${time.replaceAll(':', '-')}.json`,
    json: Option.some(json ?? { ...meal, time }),
  })

  it('keeps the Paris day, and a null note', () => {
    // 23:30 UTC on the 24th is 00:30 on the 25th in Paris
    const { rows, errors } = mealRows([
      file('2026-11-24T23:30:00.000Z'),
      file('2026-11-24T07:00:00.000Z', {
        time: '2026-11-24T07:00:00.000Z',
        kind: 'breakfast',
        note: 'croissant',
      }),
    ])
    expect(rows).toEqual([
      { time: '2026-11-24T23:30:00.000Z', day: '2026-11-25', kind: 'dinner', note: null },
      { time: '2026-11-24T07:00:00.000Z', day: '2026-11-24', kind: 'breakfast', note: 'croissant' },
    ])
    expect(errors.size).toBe(0)
  })

  it('refuses a file it cannot read, and one not named by its time', () => {
    const copied = { ...file('2026-11-24T12:00:00.000Z'), json: Option.some(meal) }
    const { rows, errors } = mealRows([
      { path: 'meals/2026/broken.json', json: Option.none() },
      copied,
      file('2026-11-24T19:30:00.000Z'),
    ])
    expect(rows.map((row) => row.time)).toEqual(['2026-11-24T19:30:00.000Z'])
    expect([...errors]).toEqual([
      ['meals/2026/broken.json', 'not a meal'],
      [copied.path, 'not a meal: its name is not its time (2026-11-24T19:30:00.000Z)'],
    ])
  })
})
