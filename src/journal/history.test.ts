import { describe, expect, it } from 'vitest'

import { anatomyCatalog } from '../../test/fixtures.ts'

import { type BodyNote, bodyHistory, heatOf, namesOf } from './history.ts'
import type { NoteBody } from './note.ts'

const period = { from: '2026-11-01', to: '2026-11-23' }

const pain = (day: string, structure: string, side: NoteBody['side'], level: number): BodyNote => ({
  time: `${day}T07:00:00.000Z`,
  day,
  text: `${structure} ${level}`,
  body: { structure, side, pain: level, kind: 'vive', when: ['descente'] },
})

describe('the body history', () => {
  it('names a structure with the side of its note, or not at all', () => {
    expect(namesOf(anatomyCatalog, { structure: 'vastus_lateralis_r', side: 'right' })).toEqual({
      french: 'vaste latéral (quadriceps)',
      english: 'Vastus lateralis (quadriceps)',
      latin: 'Musculus vastus lateralis',
      label: 'vaste latéral (quadriceps), côté droit',
    })
    expect(namesOf(anatomyCatalog, { structure: 'linea_alba', side: 'left' })?.label).toBe(
      'ligne blanche, côté gauche'
    )
    expect(namesOf(null, { structure: 'vastus_lateralis_r', side: 'right' })).toBeNull()
    expect(namesOf(anatomyCatalog, { structure: 'constructor', side: 'left' })).toBeNull()
  })

  it('follows each structure and side day by day, the worst now first', () => {
    const notes = [
      pain('2026-11-16', 'vastus_lateralis_r', 'right', 7),
      pain('2026-11-18', 'vastus_lateralis_r', 'right', 5),
      pain('2026-11-19', 'linea_alba', 'left', 2),
      pain('2026-11-20', 'linea_alba', 'right', 4),
      pain('2026-11-22', 'vastus_lateralis_r', 'right', 3),
      pain('2026-11-22', 'unknown_thing', 'left', 1),
    ]
    const history = bodyHistory(period, notes, anatomyCatalog)
    expect(history.from).toBe('2026-11-01')
    expect(history.pins.map((pin) => [pin.tissue, pin.region, pin.names?.label ?? null])).toEqual([
      ['muscle', 'thigh', 'vaste latéral (quadriceps), côté droit'],
      ['muscle', 'thigh', 'vaste latéral (quadriceps), côté droit'],
      ['fascia', 'core', 'ligne blanche, côté gauche'],
      ['fascia', 'core', 'ligne blanche, côté droit'],
      ['muscle', 'thigh', 'vaste latéral (quadriceps), côté droit'],
      [null, null, null],
    ])
    expect(history.structures.map(({ names: _, ...trend }) => trend)).toEqual([
      {
        structure: 'linea_alba',
        side: 'right',
        count: 1,
        first_day: '2026-11-20',
        last_day: '2026-11-20',
        latest_pain: 4,
        max_pain: 4,
        change: 0,
        series: [{ day: '2026-11-20', pain: 4 }],
      },
      {
        structure: 'vastus_lateralis_r',
        side: 'right',
        count: 3,
        first_day: '2026-11-16',
        last_day: '2026-11-22',
        latest_pain: 3,
        max_pain: 7,
        change: -4,
        series: [
          { day: '2026-11-16', pain: 7 },
          { day: '2026-11-18', pain: 5 },
          { day: '2026-11-22', pain: 3 },
        ],
      },
      expect.objectContaining({ structure: 'linea_alba', side: 'left', latest_pain: 2 }),
      expect.objectContaining({ structure: 'unknown_thing', latest_pain: 1 }),
    ])
    // Without the catalog: the same pins and trends, no names
    const bare = bodyHistory(period, notes, null)
    expect(bare.pins.every((pin) => pin.names === null && pin.tissue === null)).toBe(true)
    expect(history.structures.at(-1)?.names).toBeNull()
    expect(bare.structures.map((trend) => trend.structure)).toEqual(
      history.structures.map((trend) => trend.structure)
    )
  })

  it('heats a structure with its highest pain over both sides', () => {
    expect(
      heatOf([
        { structure: 'linea_alba', max_pain: 2 },
        { structure: 'linea_alba', max_pain: 6 },
        { structure: 'vastus_lateralis_r', max_pain: 3 },
      ])
    ).toEqual(
      new Map([
        ['linea_alba', 6],
        ['vastus_lateralis_r', 3],
      ])
    )
    expect(bodyHistory(period, [], null)).toEqual({ ...period, pins: [], structures: [] })
  })
})
