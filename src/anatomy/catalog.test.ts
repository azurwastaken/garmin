import { describe, expect, it } from 'vitest'

import { anatomyCatalog } from '../../test/fixtures.ts'

import {
  bodyMismatch,
  type Catalog,
  closestIds,
  isShown,
  type Layer,
  painLevel,
  pinRadius,
  readPalette,
  searchStructures,
  structureLabel,
} from './catalog.ts'

const catalog: Catalog = anatomyCatalog
const everything = () => true
const ids = (found: ReadonlyArray<readonly [string, unknown]>) => found.map(([id]) => id)

describe('the structures', () => {
  it('names a structure with the side the note gives', () => {
    expect(structureLabel('vaste latéral (quadriceps)', 'right')).toBe(
      'vaste latéral (quadriceps), côté droit'
    )
    expect(structureLabel('ligne blanche', 'left')).toBe('ligne blanche, côté gauche')
    expect(structureLabel('ligne blanche', 'midline')).toBe('ligne blanche')
  })

  it('peels by layer and side, the midline always on its side', () => {
    const muscles = new Set<Layer>(['muscle'])
    expect(isShown({ kind: 'muscle', side: 'right' }, muscles, 'both')).toBe(true)
    expect(isShown({ kind: 'muscle', side: 'right' }, muscles, 'left')).toBe(false)
    expect(isShown({ kind: 'fascia', side: 'midline' }, new Set(['surface']), 'left')).toBe(true)
    expect(isShown({ kind: 'cartilage', side: 'left' }, new Set(['ligament']), 'left')).toBe(true)
    expect(isShown({ kind: 'fascia', side: 'midline' }, muscles, 'both')).toBe(false)
  })

  it('finds a structure by its French, older French or English name, or its id', () => {
    // By French name: "tendon proximal du vaste latéral" before "vaste latéral (quadriceps)"
    expect(ids(searchStructures(catalog, 'VASTE LATERAL', everything))).toEqual([
      'vastus_lateralis_proximal_tendon_l',
      'vastus_lateralis_proximal_tendon_r',
      'vastus_lateralis_l',
      'vastus_lateralis_r',
    ])
    expect(ids(searchStructures(catalog, 'vaste externe', everything))).toEqual([
      'vastus_lateralis_l',
      'vastus_lateralis_r',
    ])
    expect(ids(searchStructures(catalog, 'patellar', everything))).toEqual(['patellar_ligament_r'])
    expect(ids(searchStructures(catalog, 'ligne', (id) => id !== 'linea_alba'))).toEqual([])
    expect(searchStructures(catalog, '', everything)).toHaveLength(6)
  })

  it('names the ids nearest an unknown one, the asked side first', () => {
    expect(closestIds(catalog, 'vastus_lateralis_right', 'right')[0]).toBe('vastus_lateralis_r')
    expect(closestIds(catalog, 'vaste_lateral_droit', 'right')[0]).toBe('vastus_lateralis_r')
    expect(closestIds(catalog, 'vastus_lateralis_left', 'left')).toEqual([
      'vastus_lateralis_l',
      'vastus_lateralis_proximal_tendon_l',
      'vastus_lateralis_r',
    ])
    expect(closestIds(catalog, 'achilles', 'left')).toEqual([])
  })
})

describe('a pinned pain', () => {
  it('fits the catalog: a known structure, on its side, a point on the model', () => {
    const body = { structure: 'vastus_lateralis_r', point: [-0.12, 0.62, 0.03] } as const
    expect(bodyMismatch({ ...body, side: 'right' }, catalog)).toBeNull()
    expect(bodyMismatch({ structure: 'linea_alba', side: 'left' }, catalog)).toBeNull()
    expect(bodyMismatch({ structure: 'vastus_lateralis_r', side: 'left' }, catalog)).toBe(
      'vastus_lateralis_r is on the right side, not left.'
    )
    expect(bodyMismatch({ structure: 'vastus_lateralis_right', side: 'right' }, catalog)).toBe(
      'Unknown structure "vastus_lateralis_right"; closest: vastus_lateralis_r, vastus_lateralis_proximal_tendon_r, vastus_lateralis_l.'
    )
    for (const structure of ['__proto__', 'constructor', 'achilles_tendon_l']) {
      expect(bodyMismatch({ structure, side: 'left' }, catalog)).toMatch(/^Unknown structure/u)
    }
  })

  it('refuses a point off the model, with or without the catalog', () => {
    for (const known of [catalog, null]) {
      expect(bodyMismatch({ structure: 'x', side: 'right', point: [1.9, 1.9, 1.9] }, known)).toBe(
        'The point [1.9,1.9,1.9] is outside the anatomy model.'
      )
      expect(
        bodyMismatch({ structure: 'vastus_lateralis_r', side: 'right', point: [0, -0.2, 0] }, known)
      ).toMatch(/outside/u)
    }
    // Without the catalog, any id the schema takes
    expect(bodyMismatch({ structure: 'x', side: 'right', point: [-0.12, 0.62, 0.03] }, null)).toBe(
      null
    )
  })

  it('takes its colour and size from its intensity', () => {
    expect([0, 3, 4, 6, 7, 10].map((pain) => painLevel(pain))).toEqual([
      'low',
      'low',
      'mid',
      'mid',
      'high',
      'high',
    ])
    expect(pinRadius(0)).toBeCloseTo(0.006)
    expect(pinRadius(10)).toBeCloseTo(0.018)
  })
})

describe('the scene palette', () => {
  it("reads the sheet's variables, trimmed", () => {
    const sheet = (page: string): Record<string, string> => ({
      '--page': page,
      '--accent': ' #3fe0ff',
      '--ink': '#e8f7ff ',
      '--good': '#a3e635',
      '--warning-ink': '#fbbf24',
      '--critical': ' #ff5470',
      '--series-2': '#f9a8d4',
      '--series-3': '#a78bfa',
    })
    const style = (page: string) => ({
      getPropertyValue: (name: string) => sheet(page)[name] ?? '',
    })
    expect(readPalette(style(' #03060b'))).toEqual({
      stage: '#03060b',
      base: '#3fe0ff',
      highlight: '#e8f7ff',
      pain: { low: '#a3e635', mid: '#fbbf24', high: '#ff5470' },
      worked: { primary: '#f9a8d4', secondary: '#a78bfa' },
    })
  })
})
