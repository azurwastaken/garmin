import { Option, Result } from 'effect'
import { describe, expect, it } from 'vitest'

import {
  caffeineRows,
  decodeIntake,
  DRINK_KINDS,
  DRINKS,
  instantOf,
  intakePath,
  resolveIntake,
} from './intake.ts'

const intake = { time: '2026-11-24T13:05:00.000Z', kind: 'espresso', mg: 63 }

describe('the drink catalog', () => {
  it('lists every drink once, in the tuple the schema takes', () => {
    expect([...DRINK_KINDS].toSorted()).toEqual(Object.keys(DRINKS).toSorted())
  })
})

describe('an intake file', () => {
  it('decodes, with or without its note', () => {
    expect(decodeIntake(intake)).toEqual(Option.some(intake))
    expect(decodeIntake({ ...intake, note: 'au bureau' })).toEqual(
      Option.some({ ...intake, note: 'au bureau' })
    )
  })

  it.each([
    ['a dose of 0', { mg: 0 }],
    ['a typo dose', { mg: 9500 }],
    ['an unknown drink', { kind: 'mate' }],
    ['a time without milliseconds', { time: '2026-11-24T13:05:00Z' }],
    ['a time in an offset', { time: '2026-11-24T14:05:00.000+01:00' }],
    ['a date that does not exist', { time: '2026-13-45T13:05:00.000Z' }],
    ['a path for a time', { time: '../../etc/passwd' }],
    ['an empty note', { note: '' }],
  ])('refuses %s', (_, change) => {
    expect(Option.isNone(decodeIntake({ ...intake, ...change }))).toBe(true)
  })

  it('is named by its time, without colons', () => {
    expect(intakePath(instantOf(Date.parse(intake.time)))).toBe(
      'caffeine/2026/2026-11-24T13-05-00.000Z.json'
    )
  })
})

// 2026-11-24 15:00 in Paris (UTC+1)
const now = Date.parse('2026-11-24T14:00:00.000Z')
const context = { now, today: '2026-11-24' }

describe('resolving what was said', () => {
  it.each([
    ['now, at the catalog’s dose', { kind: 'espresso' }, { at: now, mg: 63 }],
    ['a dose given', { kind: 'filter', mg: 140 }, { at: now, mg: 140 }],
    [
      'a time today, in Paris',
      { kind: 'double_espresso', time: '09:30' },
      { at: Date.parse('2026-11-24T08:30:00.000Z'), mg: 126 },
    ],
    [
      'a day and a time',
      { kind: 'custom', mg: 200, day: '2026-11-23', time: '18:00' },
      { at: Date.parse('2026-11-23T17:00:00.000Z'), mg: 200 },
    ],
    [
      'a few minutes ahead of the clock',
      { kind: 'black_tea', time: '15:04' },
      { at: Date.parse('2026-11-24T14:04:00.000Z'), mg: 47 },
    ],
  ] as const)('takes %s', (_, input, expected) => {
    expect(resolveIntake(input, context)).toEqual(Result.succeed(expected))
  })

  it.each([
    ['a custom drink without mg', { kind: 'custom' }],
    ['a day without a time', { kind: 'espresso', day: '2026-11-23' }],
    ['an hour that is not one', { kind: 'espresso', time: '25:00' }],
    ['a time in another shape', { kind: 'espresso', time: '9h30' }],
    ['a day in another shape', { kind: 'espresso', day: '23/11', time: '09:30' }],
    ['a time later today', { kind: 'espresso', time: '16:00' }],
  ] as const)('refuses %s', (_, input) => {
    expect(Result.isFailure(resolveIntake(input, context))).toBe(true)
  })

  it('reads the wall clock in summer time too', () => {
    expect(
      resolveIntake(
        { kind: 'espresso', day: '2026-07-01', time: '09:30' },
        { now: Date.parse('2026-07-01T12:00:00.000Z'), today: '2026-07-01' }
      )
    ).toEqual(Result.succeed({ at: Date.parse('2026-07-01T07:30:00.000Z'), mg: 63 }))
  })
})

describe('the rows from the files', () => {
  // Named by its time; its content that intake at that time unless given
  const file = (time: string, json?: unknown) => ({
    path: `caffeine/${time.slice(0, 4)}/${time.replaceAll(':', '-')}.json`,
    json: Option.some(json ?? { ...intake, time }),
  })

  it('keeps the Paris day, and a null note', () => {
    // 23:30 UTC on the 24th is 00:30 on the 25th in Paris
    const { rows, errors } = caffeineRows([
      file('2026-11-24T23:30:00.000Z'),
      file('2026-11-24T08:00:00.000Z', { ...intake, time: '2026-11-24T08:00:00.000Z', note: 'x' }),
    ])
    expect(rows).toEqual([
      { ...intake, time: '2026-11-24T23:30:00.000Z', day: '2026-11-25', note: null },
      { ...intake, time: '2026-11-24T08:00:00.000Z', day: '2026-11-24', note: 'x' },
    ])
    expect(errors.size).toBe(0)
  })

  it('refuses a file it cannot read, and one not named by its time', () => {
    const copied = { ...file('2026-11-24T09:00:00.000Z'), json: Option.some(intake) }
    const { rows, errors } = caffeineRows([
      { path: 'caffeine/2026/broken.json', json: Option.none() },
      copied,
      file('2026-11-24T13:05:00.000Z'),
    ])
    expect(rows.map((row) => row.time)).toEqual(['2026-11-24T13:05:00.000Z'])
    expect([...errors]).toEqual([
      ['caffeine/2026/broken.json', 'not a caffeine intake'],
      [copied.path, 'not a caffeine intake: its name is not its time (2026-11-24T13:05:00.000Z)'],
    ])
  })
})
