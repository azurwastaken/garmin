import type { StepInput, TopStepInput, WorkoutInput } from '../garmin/workout-builder.ts'

import type { Prescribed, SessionPlan } from './program.ts'

// A programme session as a Garmin strength workout, without I/O: the input workout-builder.ts
// turns into Garmin's JSON (create_workout's), one repeat group per exercise (its sets: each side,
// then the rest), the tempo and the load in each step's note, the real exercise named there when
// the watch shows the catalog's closest one

const WEEKDAYS = ['dim', 'lun', 'mar', 'mer', 'jeu', 'ven', 'sam'] as const

// "Renfo A - lun 30/11 - Lourd et lent", as the run plans are named
export const workoutName = (plan: Pick<SessionPlan, 'session' | 'variant'>, day: string) => {
  const weekday = WEEKDAYS[new Date(`${day}T00:00:00Z`).getUTCDay()] ?? ''
  const date = `${day.slice(8, 10)}/${day.slice(5, 7)}`
  const home = plan.variant === 'maison' ? ' (maison)' : ''
  return `Renfo ${plan.session.id} - ${weekday} ${date} - ${plan.session.name}${home}`
}

const noteOf = (exercise: Prescribed, side: string | null) =>
  [
    exercise.garmin.match === 'closest' ? exercise.name : null,
    side,
    exercise.tempo === null ? null : `tempo ${exercise.tempo}`,
    exercise.load,
  ]
    .filter((part) => part !== null)
    .join(' · ')

const stepsOf = (exercise: Prescribed): TopStepInput => {
  const sides = exercise.per_side ? ['gauche', 'droite'] : [null]
  const work = sides.map((side): StepInput => ({
    category: exercise.garmin.category,
    exercise_name: exercise.garmin.exercise_name,
    ...(exercise.reps === null ? { duration: exercise.seconds ?? 30 } : { reps: exercise.reps }),
    note: noteOf(exercise, side),
  }))
  const rest: Array<StepInput> =
    exercise.rest_s > 0 ? [{ kind: 'rest', duration: exercise.rest_s }] : []
  return { repeat: exercise.sets, steps: [...work, ...rest] }
}

export const strengthWorkout = (plan: SessionPlan, day: string): WorkoutInput => ({
  name: workoutName(plan, day),
  sport: 'strength_training',
  description: `${plan.phase.label}. ${plan.session.focus}. Échauffement 5–10 min (vélo, rameur) avant ; douleur ≤ 3/10 pendant et le lendemain.`,
  steps: plan.exercises.map(stepsOf),
})
