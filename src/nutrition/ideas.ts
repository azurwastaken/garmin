import { round } from '../numbers.ts'

import type { DayTarget } from './plan.ts'

// Meal ideas for a day's target, without I/O: a small catalogue of breakfasts, lunches (in a box,
// warmed in the office microwave), snacks and dinners (air fryer, microwave, two hobs: no oven),
// each in grams of foods whose kcal and protein are CIQUAL's; a day is one of each, its portions
// scaled to the kcal target. The user's no: broccoli, cauliflower, cucumber, salad in winter.

// Per 100 g, from the ANSES CIQUAL 2020 table (cooked where it is eaten cooked), rounded: from
// knowledge of the table, whose downloads were down when these were written
export const FOODS = {
  skyr: { name: 'Skyr nature', kcal: 64, protein_g: 11 },
  fromage_blanc: { name: 'Fromage blanc 0 %', kcal: 50, protein_g: 7.5 },
  milk: { name: 'Lait demi-écrémé', kcal: 46, protein_g: 3.3 },
  egg: { name: 'Œuf', kcal: 140, protein_g: 13 },
  emmental: { name: 'Emmental râpé', kcal: 380, protein_g: 28 },
  oats: { name: 'Flocons d’avoine', kcal: 370, protein_g: 13 },
  wholemeal_bread: { name: 'Pain complet', kcal: 240, protein_g: 9 },
  honey: { name: 'Miel', kcal: 320, protein_g: 0.4 },
  walnuts: { name: 'Cerneaux de noix', kcal: 700, protein_g: 15 },
  almonds: { name: 'Amandes', kcal: 630, protein_g: 25 },
  dark_chocolate: { name: 'Chocolat noir 70 %', kcal: 580, protein_g: 8 },
  banana: { name: 'Banane', kcal: 90, protein_g: 1.1 },
  apple: { name: 'Pomme', kcal: 53, protein_g: 0.3 },
  orange: { name: 'Orange', kcal: 45, protein_g: 0.9 },
  clementine: { name: 'Clémentines', kcal: 41, protein_g: 0.8 },
  kiwi: { name: 'Kiwi', kcal: 58, protein_g: 1.1 },
  chicken: { name: 'Filet de poulet cuit', kcal: 155, protein_g: 30 },
  turkey: { name: 'Escalope de dinde cuite', kcal: 135, protein_g: 29 },
  beef_5: { name: 'Bœuf haché 5 % cuit', kcal: 155, protein_g: 27 },
  salmon: { name: 'Saumon cuit', kcal: 205, protein_g: 24 },
  cod: { name: 'Cabillaud cuit', kcal: 100, protein_g: 22 },
  tuna: { name: 'Thon au naturel', kcal: 115, protein_g: 26 },
  rice: { name: 'Riz cuit', kcal: 130, protein_g: 2.8 },
  wholemeal_pasta: { name: 'Pâtes complètes cuites', kcal: 150, protein_g: 5.5 },
  semolina: { name: 'Semoule cuite', kcal: 120, protein_g: 4 },
  potato: { name: 'Pommes de terre cuites', kcal: 80, protein_g: 2 },
  lentils: { name: 'Lentilles cuites', kcal: 115, protein_g: 9 },
  chickpeas: { name: 'Pois chiches cuits', kcal: 140, protein_g: 8 },
  courgette: { name: 'Courgettes', kcal: 16, protein_g: 1 },
  pepper: { name: 'Poivrons', kcal: 25, protein_g: 1 },
  carrot: { name: 'Carottes', kcal: 22, protein_g: 0.7 },
  green_beans: { name: 'Haricots verts', kcal: 25, protein_g: 2 },
  peas: { name: 'Petits pois', kcal: 72, protein_g: 5 },
  corn: { name: 'Maïs doux', kcal: 100, protein_g: 3 },
  mushrooms: { name: 'Champignons de Paris', kcal: 25, protein_g: 2 },
  spinach: { name: 'Épinards', kcal: 22, protein_g: 3 },
  tomato: { name: 'Tomates concassées', kcal: 25, protein_g: 1.2 },
  butternut: { name: 'Butternut', kcal: 40, protein_g: 1 },
  olive_oil: { name: 'Huile d’olive', kcal: 900, protein_g: 0 },
} as const satisfies Record<
  string,
  { readonly name: string; readonly kcal: number; readonly protein_g: number }
>
export type FoodKey = keyof typeof FOODS

export const SLOTS = ['breakfast', 'lunch', 'snack', 'dinner'] as const
export type Slot = (typeof SLOTS)[number]

export interface Recipe {
  readonly slot: Slot
  readonly name: string
  // Each food and its grams, at scale 1
  readonly ingredients: ReadonlyArray<readonly [FoodKey, number]>
}

export const RECIPES: ReadonlyArray<Recipe> = [
  {
    slot: 'breakfast',
    name: 'Skyr, flocons d’avoine, banane et noix',
    ingredients: [
      ['skyr', 250],
      ['oats', 50],
      ['banana', 100],
      ['walnuts', 10],
    ],
  },
  {
    slot: 'breakfast',
    name: 'Fromage blanc, pomme, flocons d’avoine et miel',
    ingredients: [
      ['fromage_blanc', 250],
      ['apple', 150],
      ['oats', 40],
      ['honey', 10],
    ],
  },
  {
    slot: 'breakfast',
    name: 'Porridge au lait, banane, miel et amandes',
    ingredients: [
      ['oats', 80],
      ['milk', 300],
      ['banana', 120],
      ['honey', 20],
      ['almonds', 20],
    ],
  },
  {
    slot: 'breakfast',
    name: 'Œufs brouillés, pain complet et orange',
    ingredients: [
      ['egg', 120],
      ['wholemeal_bread', 80],
      ['orange', 150],
    ],
  },
  {
    slot: 'lunch',
    name: 'Poulet, riz, courgettes et poivrons',
    ingredients: [
      ['chicken', 150],
      ['rice', 200],
      ['courgette', 150],
      ['pepper', 100],
      ['olive_oil', 10],
    ],
  },
  {
    slot: 'lunch',
    name: 'Chili de bœuf aux lentilles, maïs et tomates',
    ingredients: [
      ['beef_5', 120],
      ['lentils', 150],
      ['corn', 60],
      ['tomato', 150],
      ['olive_oil', 5],
    ],
  },
  {
    slot: 'lunch',
    name: 'Pâtes complètes au thon, tomates et petits pois',
    ingredients: [
      ['wholemeal_pasta', 200],
      ['tuna', 120],
      ['tomato', 150],
      ['peas', 80],
      ['olive_oil', 10],
    ],
  },
  {
    slot: 'lunch',
    name: 'Pois chiches, dinde et butternut',
    ingredients: [
      ['chickpeas', 150],
      ['turkey', 130],
      ['butternut', 200],
      ['olive_oil', 10],
    ],
  },
  {
    slot: 'lunch',
    name: 'Pâtes complètes bolognaise aux champignons',
    ingredients: [
      ['wholemeal_pasta', 300],
      ['beef_5', 120],
      ['tomato', 200],
      ['mushrooms', 100],
      ['olive_oil', 10],
      ['emmental', 20],
    ],
  },
  {
    slot: 'snack',
    name: 'Skyr et clémentines',
    ingredients: [
      ['skyr', 150],
      ['clementine', 150],
    ],
  },
  {
    slot: 'snack',
    name: 'Banane et 2 carrés de chocolat noir',
    ingredients: [
      ['banana', 120],
      ['dark_chocolate', 10],
    ],
  },
  {
    slot: 'snack',
    name: 'Fromage blanc et kiwi',
    ingredients: [
      ['fromage_blanc', 200],
      ['kiwi', 100],
    ],
  },
  {
    slot: 'snack',
    name: 'Tartines de pain complet au miel et banane',
    ingredients: [
      ['wholemeal_bread', 80],
      ['honey', 20],
      ['banana', 120],
    ],
  },
  {
    slot: 'dinner',
    name: 'Saumon à l’air fryer, pommes de terre et haricots verts',
    ingredients: [
      ['salmon', 130],
      ['potato', 250],
      ['green_beans', 200],
      ['olive_oil', 5],
    ],
  },
  {
    slot: 'dinner',
    name: 'Omelette aux champignons et épinards fondus, pain complet',
    ingredients: [
      ['egg', 180],
      ['mushrooms', 150],
      ['spinach', 150],
      ['wholemeal_bread', 60],
      ['olive_oil', 5],
    ],
  },
  {
    slot: 'dinner',
    name: 'Cabillaud, écrasé de butternut et pommes de terre, carottes',
    ingredients: [
      ['cod', 180],
      ['butternut', 250],
      ['potato', 150],
      ['carrot', 150],
      ['olive_oil', 10],
    ],
  },
  {
    slot: 'dinner',
    name: 'Dinde, semoule, poivrons et courgettes',
    ingredients: [
      ['turkey', 150],
      ['semolina', 200],
      ['pepper', 100],
      ['courgette', 100],
      ['olive_oil', 10],
    ],
  },
  {
    slot: 'dinner',
    name: 'Riz sauté au poulet, poivrons, maïs et tomates',
    ingredients: [
      ['rice', 300],
      ['chicken', 130],
      ['pepper', 100],
      ['corn', 80],
      ['tomato', 100],
      ['olive_oil', 10],
    ],
  },
]

// A day is within this share of its kcal target
export const KCAL_TOLERANCE = 0.05
// How far a recipe's portions are scaled: beyond, it is another meal
export const SCALE = { min: 0.75, max: 1.5 }
// Portions are rounded to it (g)
export const STEP_G = 5

export interface Meal {
  readonly slot: Slot
  readonly name: string
  readonly portions: ReadonlyArray<{ readonly food: FoodKey; readonly g: number }>
  // Σ g × FOODS[food] / 100 over the portions, each rounded to the unit
  readonly kcal: number
  readonly protein_g: number
}

// The day's kcal and protein are the sums of its meals' (rounded) ones: what the page shows adds
// up. The meals only: a long day's carbs during the run (DayTarget.run_carbs_g_per_h) are not in
// them. none: no combination of the catalogue fits the target
export type DayIdeas =
  | {
      readonly kind: 'day'
      // The portions against the recipes' own, to the hundredth
      readonly scale: number
      readonly meals: ReadonlyArray<Meal>
      readonly kcal: number
      readonly protein_g: number
    }
  | { readonly kind: 'none' }

type Target = Pick<DayTarget, 'kcal' | 'protein_g'>
type Day = Extract<DayIdeas, { readonly kind: 'day' }>

// The kcal or the protein of foods in grams
const amountOf = (
  portions: ReadonlyArray<readonly [FoodKey, number]>,
  per100: 'kcal' | 'protein_g'
) => portions.reduce((sum, [food, g]) => sum + (g * FOODS[food][per100]) / 100, 0)

// A recipe at `scale`: each portion rounded to STEP_G, its kcal and protein from FOODS
export const mealOf = (recipe: Recipe, scale: number): Meal => {
  const portions = recipe.ingredients.map(
    ([food, g]) => [food, Math.round((g * scale) / STEP_G) * STEP_G] as const
  )
  return {
    slot: recipe.slot,
    name: recipe.name,
    portions: portions.map(([food, g]) => ({ food, g })),
    kcal: Math.round(amountOf(portions, 'kcal')),
    protein_g: Math.round(amountOf(portions, 'protein_g')),
  }
}

// One recipe of each slot, in SLOTS order: every combination, in RECIPES order
const COMBINATIONS = SLOTS.reduce<ReadonlyArray<ReadonlyArray<Recipe>>>(
  (combinations, slot) =>
    combinations.flatMap((combination) =>
      RECIPES.filter((recipe) => recipe.slot === slot).map((recipe) => [...combination, recipe])
    ),
  [[]]
)

// A combination scaled to the target's kcal, null outside SCALE or when the rounded day misses the
// tolerance or the protein
const scaledDay = (recipes: ReadonlyArray<Recipe>, target: Target): Day | null => {
  const scale =
    target.kcal / recipes.reduce((sum, recipe) => sum + amountOf(recipe.ingredients, 'kcal'), 0)
  if (scale < SCALE.min || scale > SCALE.max) return null
  const meals = recipes.map((recipe) => mealOf(recipe, scale))
  const kcal = meals.reduce((sum, meal) => sum + meal.kcal, 0)
  const protein = meals.reduce((sum, meal) => sum + meal.protein_g, 0)
  return Math.abs(kcal - target.kcal) <= KCAL_TOLERANCE * target.kcal && protein >= target.protein_g
    ? { kind: 'day', scale: round(scale, 2) ?? scale, meals, kcal, protein_g: protein }
    : null
}

// The day closest to its recipes' own portions (the smallest |ln scale|, the first on a tie) that
// fits the target; none when no combination does
export const dayIdeas = (target: Target): DayIdeas =>
  COMBINATIONS.reduce<DayIdeas>(
    (best, recipes) => {
      const day = scaledDay(recipes, target)
      if (day === null) return best
      return best.kind === 'none' || Math.abs(Math.log(day.scale)) < Math.abs(Math.log(best.scale))
        ? day
        : best
    },
    { kind: 'none' }
  )
