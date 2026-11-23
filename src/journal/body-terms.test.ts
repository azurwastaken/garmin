import { describe, expect, it } from 'vitest'

import { painSummary } from './body-terms.ts'

describe('a pain without words', () => {
  it('says itself: kind, intensity, where, and when it hurts if known', () => {
    const where = 'vaste latéral (quadriceps), côté droit'
    expect(painSummary({ pain: 6, kind: 'vive', when: ['descente', 'escaliers'] }, where)).toBe(
      'Douleur vive 6/10, vaste latéral (quadriceps), côté droit : en descente, dans les escaliers.'
    )
    expect(painSummary({ pain: 3, kind: 'brulure', when: [] }, where)).toBe(
      'Brûlure 3/10, vaste latéral (quadriceps), côté droit.'
    )
    expect(painSummary({ pain: 8, kind: 'pointe', when: ['palpation'] }, where)).toBe(
      'Douleur en pointe 8/10, vaste latéral (quadriceps), côté droit : à la palpation.'
    )
  })
})
