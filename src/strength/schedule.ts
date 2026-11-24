import { addDays, daysBetween } from '../days.ts'
import type { DayType } from '../nutrition/plan.ts'

// Where the week's strength sessions go, without I/O: never the day before a quality session or a
// long run (the legs must be fresh for it), never on the long run's day, best after the quality
// session (hard days hard, easy days easy), then on an easy day, then on a day without a run, and
// at least `minDaysApart` from another strength session, the week's and its neighbours'.

export interface WeekDay {
  readonly day: string
  // Its runs and other sessions (strength aside), done or still planned, as day-type.ts judges them
  readonly type: DayType
  // Why, from day-type.ts: « tempo » dans la séance, 80 min de course prévus…
  readonly reason: string
  // The calendar's workouts that day, by name (the watch offers one a day)
  readonly calendar: ReadonlyArray<string>
  // A strength session done or in the calendar that day
  readonly strength: boolean
}

export interface Slot {
  readonly day: string
  readonly type: DayType
  readonly reason: string
  // A calendar entry already there: the coach decides before the push
  readonly warning: string | null
}

export interface WeekPlacement {
  // Its Monday
  readonly week: string
  // The strength sessions already done or in the calendar that week
  readonly already: ReadonlyArray<string>
  readonly slots: ReadonlyArray<Slot>
  // Sessions of the target no day could take
  readonly missing: number
  // The days a rule refused, and which
  readonly rejected: ReadonlyArray<{ readonly day: string; readonly why: string }>
}

const SCORE: Record<DayType, number> = { quality: 3, easy: 2, rest: 1, long: 0 }
const HARD: ReadonlySet<DayType> = new Set(['quality', 'long'])

const restDay = (day: string): WeekDay => ({
  day,
  type: 'rest',
  reason: 'rien de prévu ni de fait',
  calendar: [],
  strength: false,
})

// Why the rules refuse a day before any pairing, else null
const refusal = (
  day: WeekDay,
  next: WeekDay,
  today: string,
  strengthDays: ReadonlyArray<string>,
  minDaysApart: number
): string | null => {
  if (day.day < today) return 'passé'
  if (day.strength) return 'renfo déjà ce jour-là'
  if (day.type === 'long') return `sortie longue ce jour-là (${day.reason})`
  if (HARD.has(next.type)) {
    return `veille ${next.type === 'long' ? 'de la sortie longue' : 'd’une séance de qualité'} (${next.reason})`
  }
  const near = strengthDays.find((other) => Math.abs(daysBetween(other, day.day)) < minDaysApart)
  return near === undefined ? null : `moins de ${minDaysApart * 24} h du renfo du ${near}`
}

const why = (day: WeekDay): string =>
  day.type === 'quality'
    ? `après la séance de qualité (${day.reason}) : jours durs durs, jours faciles faciles`
    : day.type === 'easy'
      ? `jour facile (${day.reason})`
      : 'jour sans course'

const warningOf = (day: WeekDay): string | null =>
  day.calendar.length === 0
    ? null
    : `${day.calendar.map((name) => `« ${name} »`).join(', ')} déjà au calendrier ce jour-là : avec deux séances programmées, la montre risque de ne plus proposer la course. Garde le renfo hors calendrier ce jour-là (lance-le depuis Entraînements) ou choisis un autre jour.`

// Every way to pick `size` of `items`, in order
const combinations = <A>(items: ReadonlyArray<A>, size: number): Array<Array<A>> => {
  if (size === 0) return [[]]
  return items.flatMap((item, index) =>
    combinations(items.slice(index + 1), size - 1).map((rest) => [item, ...rest])
  )
}

const smallestGap = (days: ReadonlyArray<string>) =>
  days.slice(1).reduce((gap, day, index) => Math.min(gap, daysBetween(days[index] ?? day, day)), 7)

// The smallest gap when the week repeats (the last session to next week's first): Monday and
// Thursday (3 and 4 days) spread better than Monday and Sunday (6, then 1)
const cyclicGap = (days: ReadonlyArray<string>) => {
  const [first] = days
  const last = days.at(-1)
  return first === undefined || last === undefined
    ? 7
    : Math.min(smallestGap(days), 7 - daysBetween(first, last) || 7)
}

// The best days for the sessions the week still needs: the most points (quality 3, easy 2, rest 1),
// then the widest smallest gap week after week, then the earliest. `days`: the week from the Sunday before to the
// Monday after (a missing day is one without anything)
export const placeSessions = (input: {
  readonly week: string
  readonly today: string
  readonly days: ReadonlyArray<WeekDay>
  readonly target: number
  readonly minDaysApart: number
}): WeekPlacement => {
  const { week, today, target, minDaysApart } = input
  const byDay = new Map(input.days.map((day) => [day.day, day]))
  const dayOf = (day: string) => byDay.get(day) ?? restDay(day)
  const weekDays = Array.from({ length: 7 }, (_, index) => dayOf(addDays(week, index)))
  const strengthDays = [-1, ...weekDays.map((_, index) => index), 7]
    .map((offset) => dayOf(addDays(week, offset)))
    .filter((day) => day.strength)
    .map((day) => day.day)
  const already = strengthDays.filter((day) => day >= week && day <= addDays(week, 6))

  const rejected: Array<{ day: string; why: string }> = []
  const eligible: Array<WeekDay> = []
  for (const day of weekDays) {
    const refused = refusal(day, dayOf(addDays(day.day, 1)), today, strengthDays, minDaysApart)
    if (refused === null) eligible.push(day)
    else rejected.push({ day: day.day, why: refused })
  }

  const wanted = Math.max(0, target - already.length)
  for (let size = Math.min(wanted, eligible.length); size > 0; size -= 1) {
    const spaced = combinations(eligible, size).filter(
      (picked) => smallestGap(picked.map((day) => day.day)) >= minDaysApart
    )
    const best = spaced
      .map((picked) => ({
        picked,
        score: picked.reduce((sum, day) => sum + SCORE[day.type], 0),
        gap: cyclicGap(picked.map((day) => day.day)),
      }))
      .toSorted((a, b) => b.score - a.score || b.gap - a.gap)[0]
    if (best !== undefined) {
      return {
        week,
        already,
        slots: best.picked.map((day) => ({
          day: day.day,
          type: day.type,
          reason: why(day),
          warning: warningOf(day),
        })),
        missing: wanted - size,
        rejected,
      }
    }
  }
  return { week, already, slots: [], missing: wanted, rejected }
}
