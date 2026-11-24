import { Schema } from 'effect'
import { describe, expect, it } from 'vitest'

import { DEFAULT_PLAN, NutritionPlanJson, phaseOn, targetFor } from './plan.ts'

const decode = Schema.decodeUnknownResult(NutritionPlanJson)
const refused = (plan: unknown) => decode(plan)._tag === 'Failure'

describe('the nutrition plan', () => {
  it('decodes the plan agreed on 2026-11-16', () => {
    expect(decode(JSON.parse(JSON.stringify(DEFAULT_PLAN)))).toMatchObject({
      _tag: 'Success',
      success: DEFAULT_PLAN,
    })
  })

  it('refuses ranges upside down and phases out of order or overlapping', () => {
    expect(refused({ ...DEFAULT_PLAN, loss_kg_per_week: { min: 0.5, max: 0.3 } })).toBe(true)
    expect(refused({ ...DEFAULT_PLAN, kcal: { ...DEFAULT_PLAN.kcal, rest: 100 } })).toBe(true)
    const [deficit, maintenance] = DEFAULT_PLAN.phases
    expect(refused({ ...DEFAULT_PLAN, phases: [maintenance, deficit] })).toBe(true)
    expect(
      refused({ ...DEFAULT_PLAN, phases: [deficit, { ...maintenance, from: '2027-01-31' }] })
    ).toBe(true)
    expect(refused({ ...DEFAULT_PLAN, phases: [{ ...deficit, to: '2026-11-01' }] })).toBe(true)
    expect(refused({ ...DEFAULT_PLAN, phases: [] })).toBe(false)
  })

  it('finds the phase a day falls in, its first and last days included', () => {
    expect(phaseOn(DEFAULT_PLAN.phases, '2026-11-18')).toBeNull()
    expect(phaseOn(DEFAULT_PLAN.phases, '2026-11-19')?.kind).toBe('deficit')
    expect(phaseOn(DEFAULT_PLAN.phases, '2027-01-31')?.kind).toBe('deficit')
    expect(phaseOn(DEFAULT_PLAN.phases, '2027-02-01')?.kind).toBe('maintenance')
    expect(phaseOn(DEFAULT_PLAN.phases, '2027-04-12')).toBeNull()
  })

  it('asks the day type’s kcal, the protein, and carbs during the run on a long day only', () => {
    expect(targetFor(DEFAULT_PLAN, 'easy')).toEqual({
      kcal: 2600,
      protein_g: 130,
      run_carbs_g_per_h: null,
    })
    expect(targetFor(DEFAULT_PLAN, 'long')).toEqual({
      kcal: 3400,
      protein_g: 130,
      run_carbs_g_per_h: { min: 40, max: 60 },
    })
    expect(targetFor(DEFAULT_PLAN, 'rest').kcal).toBe(1900)
    expect(targetFor(DEFAULT_PLAN, 'quality').kcal).toBe(2850)
  })
})
