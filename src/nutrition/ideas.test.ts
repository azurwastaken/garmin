import { describe, expect, it } from 'vitest'

import {
  dayIdeas,
  FOODS,
  KCAL_TOLERANCE,
  type Meal,
  mealOf,
  RECIPES,
  SLOTS,
  STEP_G,
} from './ideas.ts'
import { DAY_TYPES, DEFAULT_PLAN, targetFor } from './plan.ts'

// The user's no, and salad greens (winter): never in a food's or a recipe's name
const FORBIDDEN =
  /brocoli|chou[- ]fleur|concombre|cornichon|salade|laitue|m[âa]che|roquette|mesclun|scarole|fris[ée]e/iu
// No oven in the kitchen
const OVEN = /\bfour\b|gratin|r[ôo]ti/iu

// A meal's kcal or protein from its portions, recomputed from FOODS
const recomputed = (meal: Meal, per100: 'kcal' | 'protein_g') =>
  Math.round(meal.portions.reduce((sum, { food, g }) => sum + (g * FOODS[food][per100]) / 100, 0))

describe('the catalogue', () => {
  it('has every slot, and none of the user’s no or the oven', () => {
    for (const slot of SLOTS) expect(RECIPES.some((recipe) => recipe.slot === slot)).toBe(true)
    for (const { name } of [...Object.values(FOODS), ...RECIPES]) {
      expect(name).not.toMatch(FORBIDDEN)
    }
    for (const { name } of RECIPES) expect(name).not.toMatch(OVEN)
  })

  it('scales a recipe’s portions to 5 g and computes its totals', () => {
    const [skyrBowl] = RECIPES
    if (skyrBowl === undefined) return expect.fail('no recipe')
    // 250 g skyr, 50 g oats, 100 g banana, 10 g walnuts: 160 + 185 + 90 + 70 kcal
    expect(mealOf(skyrBowl, 1)).toMatchObject({ kcal: 505, protein_g: 37 })
    // ×1.1: 275, 55, 110, 11 → 10 g
    expect(mealOf(skyrBowl, 1.1).portions.map((portion) => portion.g)).toEqual([275, 55, 110, 10])
  })
})

describe('a day of ideas', () => {
  it('fits every day type of the plan: its kcal within 5 %, at least its protein', () => {
    for (const type of DAY_TYPES) {
      const target = targetFor(DEFAULT_PLAN, type)
      const day = dayIdeas(target)
      if (day.kind === 'none') return expect.fail(`no day for ${type}`)
      expect(day.meals.map((meal) => meal.slot)).toEqual(SLOTS)
      expect(Math.abs(day.kcal - target.kcal)).toBeLessThanOrEqual(KCAL_TOLERANCE * target.kcal)
      expect(day.protein_g).toBeGreaterThanOrEqual(target.protein_g)
      // Totals computed, never typed: each meal from its portions, the day from its meals
      for (const meal of day.meals) {
        expect(meal.kcal).toBe(recomputed(meal, 'kcal'))
        expect(meal.protein_g).toBe(recomputed(meal, 'protein_g'))
        for (const { g } of meal.portions) expect(g % STEP_G).toBe(0)
      }
      expect(day.kcal).toBe(day.meals.reduce((sum, meal) => sum + meal.kcal, 0))
      expect(day.protein_g).toBe(day.meals.reduce((sum, meal) => sum + meal.protein_g, 0))
    }
  })

  it('picks the day closest to the recipes’ own portions', () => {
    // The rest day's 1 900 kcal: a combination at its portions, never one scaled
    expect(dayIdeas(targetFor(DEFAULT_PLAN, 'rest'))).toMatchObject({
      scale: 1,
      meals: [
        { name: 'Skyr, flocons d’avoine, banane et noix' },
        { name: 'Pâtes complètes au thon, tomates et petits pois' },
        { name: 'Skyr, banane et 2 carrés de chocolat noir' },
        { name: 'Omelette aux champignons et épinards fondus, pain complet' },
      ],
    })
  })

  it('is none for a target nothing fits: its protein, or past the portions’ bounds', () => {
    expect(dayIdeas({ kcal: 1900, protein_g: 400 })).toEqual({ kind: 'none' })
    // The lightest day is 1 556 kcal: 1 000 is under its 0.75×, 6 000 over the heaviest's 1.5×
    expect(dayIdeas({ kcal: 1000, protein_g: 0 })).toEqual({ kind: 'none' })
    expect(dayIdeas({ kcal: 6000, protein_g: 130 })).toEqual({ kind: 'none' })
  })
})
