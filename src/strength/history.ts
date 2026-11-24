import { addDays, mondayOf } from '../days.ts'

// The strength sessions done, without I/O: the sessions per week against the target, each key
// exercise's progression session by session, the last session in full

export interface StrengthActivity {
  readonly id: number
  readonly day: string
  readonly name: string | null
  // The workout the watch ran (its calendar name, "Renfo A - …"), from the FIT file
  readonly workout_name: string | null
  readonly minutes: number | null
}

// A strength_sets row
export interface SetRow {
  readonly activity_id: number
  readonly idx: number
  readonly category: string | null
  readonly exercise_name: string | null
  readonly reps: number | null
  readonly weight_kg: number | null
  readonly duration_s: number | null
}

export interface WeekCount {
  // Its Monday
  readonly week: string
  readonly sessions: number
}

export interface ProgressPoint {
  readonly day: string
  readonly activity_id: number
  readonly sets: number
  readonly reps: number
  // The heaviest set's load, and the best estimated one-repetition maximum (Epley), with a load
  readonly top_kg: number | null
  readonly e1rm_kg: number | null
  // Σ load × reps
  readonly volume_kg: number
  // Σ seconds, for a held exercise (a plank)
  readonly seconds: number
}

export interface Progression {
  // The catalog's keys: CATEGORY/EXERCISE_NAME
  readonly key: string
  readonly name: string
  readonly points: ReadonlyArray<ProgressPoint>
}

export interface LastSession {
  readonly activity: StrengthActivity
  readonly exercises: ReadonlyArray<{
    readonly key: string | null
    readonly name: string
    readonly sets: ReadonlyArray<Pick<SetRow, 'reps' | 'weight_kg' | 'duration_s'>>
  }>
}

// The sessions of each of the `weeks` weeks up to `today`'s, oldest first, empty weeks included
export const weeklyCounts = (
  days: ReadonlyArray<string>,
  today: string,
  weeks: number
): Array<WeekCount> => {
  const last = mondayOf(today)
  const counts = Map.groupBy(days, mondayOf)
  return Array.from({ length: weeks }, (_, index) => {
    const week = addDays(last, -7 * (weeks - 1 - index))
    return { week, sessions: counts.get(week)?.length ?? 0 }
  })
}

// Epley's estimate of the one-repetition maximum: a load lifted 1 to 12 times, else null (past 12
// the estimate says more about endurance than strength)
export const epley = (kg: number | null, reps: number | null): number | null =>
  kg === null || reps === null || kg <= 0 || reps < 1 || reps > 12
    ? null
    : Math.round(kg * (1 + reps / 30) * 10) / 10

export const keyOf = (set: Pick<SetRow, 'category' | 'exercise_name'>) =>
  set.category === null || set.exercise_name === null
    ? null
    : `${set.category}/${set.exercise_name}`

const maxOrNull = (values: ReadonlyArray<number | null>) => {
  const present = values.filter((value) => value !== null)
  return present.length === 0 ? null : Math.max(...present)
}

const pointOf = (activity: StrengthActivity, sets: ReadonlyArray<SetRow>): ProgressPoint => ({
  day: activity.day,
  activity_id: activity.id,
  sets: sets.length,
  reps: sets.reduce((sum, set) => sum + (set.reps ?? 0), 0),
  top_kg: maxOrNull(sets.map((set) => set.weight_kg)),
  e1rm_kg: maxOrNull(sets.map((set) => epley(set.weight_kg, set.reps))),
  volume_kg: Math.round(sets.reduce((sum, set) => sum + (set.weight_kg ?? 0) * (set.reps ?? 0), 0)),
  seconds: Math.round(sets.reduce((sum, set) => sum + (set.duration_s ?? 0), 0)),
})

// Each exercise of `keys` (the programme's), then any other done in two sessions or more: its
// points session by session, oldest first; `nameOf` names a key
export const progressions = (
  sets: ReadonlyArray<SetRow>,
  activities: ReadonlyArray<StrengthActivity>,
  keys: ReadonlyArray<string>,
  nameOf: (key: string) => string
): Array<Progression> => {
  const dayOrder = activities.toSorted((a, b) => a.day.localeCompare(b.day) || a.id - b.id)
  const byKey = Map.groupBy(
    sets.filter((set) => keyOf(set) !== null),
    (set) => keyOf(set) ?? ''
  )
  const pointsOf = (key: string) => {
    const byActivity = Map.groupBy(byKey.get(key) ?? [], (set) => set.activity_id)
    return dayOrder.flatMap((activity) => {
      const done = byActivity.get(activity.id)
      return done === undefined ? [] : [pointOf(activity, done)]
    })
  }
  const others = [...byKey.keys()].filter(
    (key) => !keys.includes(key) && new Set(byKey.get(key)?.map((set) => set.activity_id)).size >= 2
  )
  return [...new Set([...keys, ...others])]
    .map((key) => ({ key, name: nameOf(key), points: pointsOf(key) }))
    .filter((progression) => progression.points.length > 0)
}

// The newest session, its sets grouped by exercise in the order done
export const lastSession = (
  sets: ReadonlyArray<SetRow>,
  activities: ReadonlyArray<StrengthActivity>,
  nameOf: (key: string) => string
): LastSession | null => {
  const [activity] = activities.toSorted((a, b) => b.day.localeCompare(a.day) || b.id - a.id)
  if (activity === undefined) return null
  const own = sets
    .filter((set) => set.activity_id === activity.id)
    .toSorted((a, b) => a.idx - b.idx)
  // Consecutive sets of one exercise are one line; the same exercise later again is a new one
  const exercises: Array<{ key: string | null; name: string; sets: Array<SetRow> }> = []
  for (const set of own) {
    const key = keyOf(set)
    const current = exercises.at(-1)
    if (current !== undefined && current.key === key) current.sets.push(set)
    else
      exercises.push({
        key,
        name: key === null ? 'exercice non reconnu' : nameOf(key),
        sets: [set],
      })
  }
  return {
    activity,
    exercises: exercises.map(({ key, name, sets: done }) => ({
      key,
      name,
      sets: done.map(({ reps, weight_kg, duration_s }) => ({ reps, weight_kg, duration_s })),
    })),
  }
}

// The programme session a strength activity ran ("Renfo B - jeu 03/12 - …"), else null
export const sessionIdOf = (activity: Pick<StrengthActivity, 'name' | 'workout_name'>) =>
  /^Renfo ([A-Z])\b/u.exec(activity.workout_name ?? activity.name ?? '')?.[1] ?? null
