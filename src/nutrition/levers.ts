import { fmt, hours } from '../components/format.ts'
import { addDays, daysBetween, mondayOf, parisMinutesFromNoon } from '../days.ts'
import { mean, round } from '../numbers.ts'

import type { NutritionPlan } from './plan.ts'

// The levers toward the peak weight, without I/O: each with its number from the user's own data
// over its window, its expected effect when it is energy, and a plain French sentence; the ones
// the data shows room on first. Meals are not recorded: a lever on them says so rather than
// pretend to measure a gap.

// Running, a kcal a km: the coach's figure (about 1 kcal per kg of body weight per km)
export const KCAL_PER_KM = 75
// A kg of body fat, in kcal: the usual rule of thumb
export const KCAL_PER_KG_FAT = 7700
// Km a week of a first marathon plan: Hal Higdon's Novice 1, its first week and its peak
export const MARATHON_PLAN_KM = { start: 24, peak: 64 }
// Protein in a deficit to keep the lean mass (g a kg of body weight): ISSN 2017 (Jäger et al.),
// 1.4–2.0 g/kg for athletes and more in a deficit
export const PROTEIN_G_PER_KG = { min: 1.8, max: 2.2 }
// Strength sessions a week: ACSM, resistance training two days a week at least
export const STRENGTH_PER_WEEK = 2
// Steps a day, and what 2 000 more burn: the coach's figures
export const STEPS_GOAL = 10_000
export const KCAL_PER_2000_STEPS = 100
// Hours a night: AASM and SRS 2015, adults 7 h at least
export const SLEEP_MIN_H = 7
// 00:30 on parisMinutesFromNoon's axis: a later bedtime is a late night
export const LATE_BEDTIME = 750
// More than one late night a week is room
export const LATE_NIGHTS_MAX_SHARE = 1 / 7
// An illustration of a day over its target: a dessert or a drink
export const REST_DAY_OVER_KCAL = 300
// The running coaches' 10 % rule, kept for the knee
export const MAX_WEEKLY_INCREASE = 0.1
// CIQUAL (ANSES): a croissant about 240 kcal, a pain au chocolat about 290; a 150 g skyr, a fruit
// and 30 g of oats about 290: swapping a two-pastry breakfast saves about 200 to 300 kcal a day
export const BREAKFAST_SWAP_KCAL = { min: 200, max: 300 }

interface Window {
  readonly from: string
  readonly to: string
}

export interface LeverWindows {
  // The 28 days before today (today, unfinished, left out)
  readonly days: Window
  // The 28 nights ending this morning (daily.day is the morning a night ends)
  readonly nights: Window
  // The 8 full ISO weeks before this one
  readonly weeks: Window
}

// What the shell reads over leverWindows
export interface LeverFacts {
  // Days with an activity, in `days`
  readonly active_days: number
  // strength_training activities, in `weeks`
  readonly strength_sessions: number
  // Km of running (running, treadmill_running, trail_running), in `weeks`
  readonly running_km: number
  // Each day's steps, in `days`: days without any left out
  readonly steps: ReadonlyArray<number>
  // Each night, in `nights`
  readonly nights: ReadonlyArray<{
    readonly sleep_s: number | null
    readonly sleep_start: string | null
  }>
}

export const LEVER_KEYS = [
  'rest-days',
  'breakfast',
  'protein',
  'strength',
  'running',
  'steps',
  'sleep',
] as const
export type LeverKey = (typeof LEVER_KEYS)[number]

interface Measured {
  readonly value: number
  readonly unit: string
  readonly from: string
  readonly to: string
}

// room: the data shows room; fine: it shows none; untracked: what the lever acts on is not
// recorded (meals); no-data: nothing in its window
export type Lever = {
  readonly key: LeverKey
  // The expected effect, when it is energy
  readonly kcal_per_day: { readonly min: number; readonly max: number } | null
  // In French, with the number
  readonly text: string
} & (
  | { readonly status: 'room' | 'fine'; readonly measured: Measured }
  | { readonly status: 'untracked'; readonly measured: Measured | null }
  | { readonly status: 'no-data'; readonly measured: null }
)

// The windows the levers read, from today
export const leverWindows = (today: string): LeverWindows => {
  const monday = mondayOf(today)
  return {
    days: { from: addDays(today, -28), to: addDays(today, -1) },
    nights: { from: addDays(today, -27), to: today },
    weeks: { from: addDays(monday, -56), to: addDays(monday, -1) },
  }
}

// A window's days, its first and last included
const daysIn = (window: Window) => daysBetween(window.from, window.to) + 1

const plural = (count: number, word: string) => `${fmt(count)} ${word}${count > 1 ? 's' : ''}`

const kcalEach = (kcal: number) => {
  const whole = Math.round(kcal)
  return { min: whole, max: whole }
}

// The days without a session: always untracked (meals are not recorded); its number, the rest
// days, is where the plan's deficit is made
const restDaysLever = (activeDays: number, days: Window, restKcal: number): Lever => {
  const rest = daysIn(days) - activeDays
  return {
    key: 'rest-days',
    status: 'untracked',
    measured: { value: rest, unit: 'jours sans séance', ...days },
    kcal_per_day: null,
    text: `${plural(rest, 'jour')} sans séance sur ${daysIn(days)} : à ${fmt(restKcal)} kcal, ce sont eux qui font le déficit. Les repas ne sont pas suivis : ${REST_DAY_OVER_KCAL} kcal de trop un jour de repos effacent environ ${fmt((REST_DAY_OVER_KCAL / KCAL_PER_KG_FAT) * 1000)} g de graisse perdue.`,
  }
}

// The pastry breakfast: untracked, nothing measured; the swap's saving is its effect
const BREAKFAST_LEVER: Lever = {
  key: 'breakfast',
  status: 'untracked',
  measured: null,
  kcal_per_day: BREAKFAST_SWAP_KCAL,
  text: `Viennoiseries au petit-déjeuner, et l’alcool : un skyr, un fruit et des flocons d’avoine à la place font environ ${BREAKFAST_SWAP_KCAL.min} à ${BREAKFAST_SWAP_KCAL.max} kcal de moins par jour, avec plus de protéines.`,
}

// The plan's protein per kg of the weight (intake is not recorded: it judges the plan's target);
// room under PROTEIN_G_PER_KG.min; no-data without a weight
const proteinLever = (
  weight: { readonly kg: number; readonly from: string; readonly to: string } | null,
  proteinG: number
): Lever => {
  if (weight === null) {
    return {
      key: 'protein',
      status: 'no-data',
      measured: null,
      kcal_per_day: null,
      text: `Aucune pesée : les ${fmt(proteinG)} g de protéines du plan ne se rapportent à aucun poids.`,
    }
  }
  const perKg = round(proteinG / weight.kg, 2) ?? 0
  const range = `${fmt(PROTEIN_G_PER_KG.min, 1)} à ${fmt(PROTEIN_G_PER_KG.max, 1)} g/kg, soit ${fmt(PROTEIN_G_PER_KG.min * weight.kg)} à ${fmt(PROTEIN_G_PER_KG.max * weight.kg)} g pour ${fmt(weight.kg, 1)} kg`
  const room = perKg < PROTEIN_G_PER_KG.min
  return {
    key: 'protein',
    status: room ? 'room' : 'fine',
    measured: { value: perKg, unit: 'g/kg', from: weight.from, to: weight.to },
    kcal_per_day: null,
    text: `Le plan prévoit ${fmt(proteinG)} g de protéines, ${fmt(perKg, 2)} g/kg : ${room ? 'sous' : 'dans'} la fourchette qui garde le muscle en déficit (${range}). Les apports ne sont pas suivis${room ? '' : ' : vise le haut les jours durs'}.`,
  }
}

// Strength sessions over the weeks: room under STRENGTH_PER_WEEK a week
const strengthLever = (sessions: number, weeks: Window): Lever => {
  const count = daysIn(weeks) / 7
  const needed = STRENGTH_PER_WEEK * count
  const room = sessions < needed
  return {
    key: 'strength',
    status: room ? 'room' : 'fine',
    measured: { value: sessions, unit: 'séances', ...weeks },
    kcal_per_day: null,
    text: `${plural(sessions, 'séance')} de renforcement en ${fmt(count)} semaines, pour ${fmt(needed)} attendues : ${STRENGTH_PER_WEEK} par semaine gardent le muscle pendant le déficit${room ? '' : ', c’est tenu'}.`,
  }
}

// Running km a week over the weeks: room under a first marathon plan's first week, whose km would
// burn the difference
const runningLever = (km: number, weeks: Window): Lever => {
  const perWeek = round(km / (daysIn(weeks) / 7), 1) ?? 0
  const room = perWeek < MARATHON_PLAN_KM.start
  const measured = { value: perWeek, unit: 'km/sem.', ...weeks }
  const plan = `un premier plan marathon (Higdon Novice 1) part de ${MARATHON_PLAN_KM.start} km et monte à ${MARATHON_PLAN_KM.peak}`
  const ramp = `en montant de ${fmt(MAX_WEEKLY_INCREASE * 100)} % par semaine au plus, pour le genou`
  if (!room) {
    return {
      key: 'running',
      status: 'fine',
      measured,
      kcal_per_day: null,
      text: `${fmt(perWeek, 1)} km de course par semaine en moyenne : ${plan}, la base est là ; continue ${ramp}.`,
    }
  }
  const kcal = kcalEach(((MARATHON_PLAN_KM.start - perWeek) * KCAL_PER_KM) / 7)
  return {
    key: 'running',
    status: 'room',
    measured,
    kcal_per_day: kcal,
    text: `${fmt(perWeek, 1)} km de course par semaine en moyenne ; ${plan}. Aller jusqu’à ${MARATHON_PLAN_KM.start} km brûle environ ${fmt(kcal.max)} kcal de plus par jour (${KCAL_PER_KM} kcal/km), ${ramp}.`,
  }
}

// Steps a day over the days: room under STEPS_GOAL, whose missing steps would burn the
// difference; no-data without any day's steps
const stepsLever = (steps: ReadonlyArray<number>, days: Window): Lever => {
  const average = mean(steps)
  if (average === null) {
    return {
      key: 'steps',
      status: 'no-data',
      measured: null,
      kcal_per_day: null,
      text: 'Aucun nombre de pas sur la période.',
    }
  }
  const perDay = Math.round(average)
  const measured = { value: perDay, unit: 'pas/jour', ...days }
  if (perDay >= STEPS_GOAL) {
    return {
      key: 'steps',
      status: 'fine',
      measured,
      kcal_per_day: null,
      text: `${fmt(perDay)} pas par jour en moyenne sur ${plural(steps.length, 'jour')} : au-dessus de ${fmt(STEPS_GOAL)}, la marche fait déjà sa part.`,
    }
  }
  const kcal = kcalEach(((STEPS_GOAL - perDay) / 2000) * KCAL_PER_2000_STEPS)
  return {
    key: 'steps',
    status: 'room',
    measured,
    kcal_per_day: kcal,
    text: `${fmt(perDay)} pas par jour en moyenne sur ${plural(steps.length, 'jour')} : ${fmt(STEPS_GOAL - perDay)} de plus pour atteindre ${fmt(STEPS_GOAL)} font environ ${fmt(kcal.max)} kcal de plus par jour (${KCAL_PER_2000_STEPS} kcal par 2 000 pas).`,
  }
}

// Sleep over the nights: room under SLEEP_MIN_H on average, or with more than one night a week
// asleep after 00:30 (unknown bedtimes leave that test out); no-data without a measured night
const sleepLever = (nights: LeverFacts['nights'], window: Window): Lever => {
  const slept = nights.flatMap((night) => (night.sleep_s === null ? [] : [night.sleep_s]))
  const average = mean(slept)
  if (average === null) {
    return {
      key: 'sleep',
      status: 'no-data',
      measured: null,
      kcal_per_day: null,
      text: 'Aucune nuit mesurée sur la période.',
    }
  }
  const bedtimes = nights.flatMap((night) => {
    const minutes = parisMinutesFromNoon(night.sleep_start)
    return minutes === null ? [] : [minutes]
  })
  const late = bedtimes.filter((minutes) => minutes > LATE_BEDTIME).length
  const share = bedtimes.length === 0 ? null : late / bedtimes.length
  const short = average / 3600 < SLEEP_MIN_H
  const room = short || (share !== null && share > LATE_NIGHTS_MAX_SHARE)
  const lateText =
    share === null
      ? 'heures de coucher inconnues'
      : `${plural(late, 'coucher')} après 00 h 30 sur ${plural(bedtimes.length, 'nuit')}`
  return {
    key: 'sleep',
    status: room ? 'room' : 'fine',
    measured: { value: round(average / 3600, 2) ?? 0, unit: 'h', ...window },
    kcal_per_day: null,
    text: `${hours(average)} de sommeil en moyenne sur ${plural(slept.length, 'nuit')}, ${lateText} : ${room ? `dormir court ou tard creuse la faim et freine la récupération ; vise ${SLEEP_MIN_H} h au moins et un coucher avant 00 h 30.` : 'garde ce rythme.'}`,
  }
}

const STATUS_RANK: Record<Lever['status'], number> = {
  room: 0,
  untracked: 1,
  fine: 2,
  'no-data': 3,
}

// The seven levers, ranked by status (room, untracked, fine, no-data), then by their effect's max
// (none counts 0), then in LEVER_KEYS order (the order they are built in: the sort is stable)
export const leversOf = (input: {
  readonly facts: LeverFacts
  readonly windows: LeverWindows
  readonly plan: Pick<NutritionPlan, 'protein_g' | 'kcal'>
  // The weight protein is per kg of, with the days it is the mean of
  readonly weight: { readonly kg: number; readonly from: string; readonly to: string } | null
}): Array<Lever> => {
  const { facts, windows, plan } = input
  return [
    restDaysLever(facts.active_days, windows.days, plan.kcal.rest),
    BREAKFAST_LEVER,
    proteinLever(input.weight, plan.protein_g),
    strengthLever(facts.strength_sessions, windows.weeks),
    runningLever(facts.running_km, windows.weeks),
    stepsLever(facts.steps, windows.days),
    sleepLever(facts.nights, windows.nights),
  ].toSorted(
    (a, b) =>
      STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
      (b.kcal_per_day?.max ?? 0) - (a.kcal_per_day?.max ?? 0)
  )
}
