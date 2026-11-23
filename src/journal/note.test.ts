import { Option } from 'effect'
import { describe, expect, it } from 'vitest'

import { decodeNote } from './note.ts'

const note = { time: '2026-11-23T08:00:00.000Z', day: '2026-11-23', text: 'Quadri raide' }
const body = {
  structure: 'vastus_lateralis_r',
  side: 'right',
  point: [-0.12, 0.62, 0.03],
  pain: 6,
  kind: 'vive',
  when: ['descente', 'escaliers'],
  since: '2026-11-16',
}

describe('a journal note', () => {
  it('decodes an old note, without a body, unchanged', () => {
    expect(decodeNote(note)).toEqual(Option.some(note))
  })

  it('decodes a pinned pain; its point and its start are optional', () => {
    expect(decodeNote({ ...note, body })).toEqual(Option.some({ ...note, body }))
    const { point: _point, since: _since, ...named } = body
    expect(decodeNote({ ...note, body: { ...named, when: [] } })).toEqual(
      Option.some({ ...note, body: { ...named, when: [] } })
    )
  })

  it.each([
    ['an intensity over 10', { pain: 11 }],
    ['a negative intensity', { pain: -1 }],
    ['a fractional intensity', { pain: 6.5 }],
    ['an unknown side', { side: 'up' }],
    ['an unknown kind', { kind: 'aiguë' }],
    ['an unknown moment', { when: ['marche'] }],
    ['a moment twice', { when: ['nuit', 'nuit'] }],
    ['a point with two coordinates', { point: [0, 1] }],
    ['a point far off', { point: [0, 3, 0] }],
    ['a point not a number', { point: [0, Number.NaN, 0] }],
    ['an id with a slash', { structure: '../vastus' }],
    ['a start not a day', { since: 'lundi' }],
  ])('refuses %s', (_, change) => {
    expect(Option.isNone(decodeNote({ ...note, body: { ...body, ...change } }))).toBe(true)
  })
})
