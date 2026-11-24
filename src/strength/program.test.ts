import { existsSync, readFileSync } from 'node:fs'

import { Schema } from 'effect'
import { describe, expect, it } from 'vitest'

import { buildWorkout, EXERCISES } from '../garmin/workout-builder.ts'
import { dayType } from '../nutrition/day-type.ts'

import {
  DEFAULT_PROGRAM,
  nextSession,
  phaseOn,
  sessionPlan,
  type StrengthProgram,
  StrengthProgramJson,
} from './program.ts'
import { MODEL_MUSCLES_AND_TENDONS } from './structures.ts'
import { strengthWorkout, workoutName } from './workout.ts'

const decode = Schema.decodeUnknownSync(StrengthProgramJson)
const refusal = (program: unknown) => {
  try {
    decode(program)
    return null
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

const withExercise = (change: Partial<StrengthProgram['exercises'][number]>) => ({
  ...DEFAULT_PROGRAM,
  exercises: DEFAULT_PROGRAM.exercises.map((exercise, index) =>
    index === 0 ? { ...exercise, ...change } : exercise
  ),
})

describe('the programme', () => {
  it('holds together: its default decodes, every muscle a structure of the model', () => {
    expect(decode(DEFAULT_PROGRAM)).toEqual(DEFAULT_PROGRAM)
    const ids = new Set<string>(MODEL_MUSCLES_AND_TENDONS)
    for (const exercise of DEFAULT_PROGRAM.exercises) {
      for (const id of [...exercise.primary, ...exercise.secondary]) expect(ids).toContain(id)
    }
  })

  it('refuses a muscle the anatomy model does not have', () => {
    expect(refusal(withExercise({ primary: ['quadriceps_r'] }))).toContain(
      'quadriceps_r : pas un muscle ni un tendon du modèle anatomique'
    )
    expect(refusal(withExercise({ secondary: ['rectus_femoris_x'] }))).toContain('rectus_femoris_x')
    expect(refusal(withExercise({ primary: [] }))).not.toBeNull()
  })

  it('names Garmin catalog entries only, exact or closest', () => {
    const keys = new Set(EXERCISES.map((entry) => `${entry.category}/${entry.exercise}`))
    for (const exercise of DEFAULT_PROGRAM.exercises) {
      expect(keys).toContain(`${exercise.garmin.category}/${exercise.garmin.exercise_name}`)
      if (exercise.maison !== null) {
        expect(keys).toContain(
          `${exercise.maison.garmin.category}/${exercise.maison.garmin.exercise_name}`
        )
      }
    }
    // The catalog has no step-down, Copenhagen plank, Nordic curl, Pallof press nor pogo hop
    expect(
      DEFAULT_PROGRAM.exercises.filter((e) => e.garmin.match === 'closest').map((e) => e.id)
    ).toEqual(['step_down', 'copenhagen_plank', 'nordic_curl', 'pallof_press', 'pogo_hops'])
    expect(
      refusal(
        withExercise({
          garmin: { category: 'LUNGE', exercise_name: 'NOT_AN_EXERCISE', match: 'exact' },
        })
      )
    ).toContain('LUNGE/NOT_AN_EXERCISE : pas dans le catalogue Garmin')
  })

  it('refuses a dose of both reps and seconds, or of neither', () => {
    expect(refusal(withExercise({ dose: { sets: 3, reps: 8, seconds: 20, load: 'x' } }))).toContain(
      'exactement un de reps ou seconds'
    )
    expect(refusal(withExercise({ dose: { sets: 3, load: 'x' } }))).toContain('exactement un')
  })

  it('refuses overlapping phases, a twice-defined exercise, an unknown one in a session', () => {
    const [base, build] = DEFAULT_PROGRAM.phases
    expect(refusal({ ...DEFAULT_PROGRAM, phases: [build, base] })).toContain(
      'dans l’ordre des dates'
    )
    expect(
      refusal({
        ...DEFAULT_PROGRAM,
        exercises: [...DEFAULT_PROGRAM.exercises, DEFAULT_PROGRAM.exercises[0]],
      })
    ).toContain('split_squat deux fois')
    expect(
      refusal({
        ...DEFAULT_PROGRAM,
        sessions: [{ id: 'A', name: 'x', focus: 'x', exercises: ['squat_jump'] }],
      })
    ).toContain('A → squat_jump')
  })

  // Run with ANATOMY_STRUCTURES=<DATA_DIR>/anatomy/structures.json: the snapshot is the model's
  it.skipIf(process.env['ANATOMY_STRUCTURES'] === undefined)(
    "keeps a snapshot of the model's own muscles and tendons",
    () => {
      const path = process.env['ANATOMY_STRUCTURES'] ?? ''
      expect(existsSync(path)).toBe(true)
      const catalog = JSON.parse(readFileSync(path, 'utf8')) as Record<string, { kind: string }>
      const real = Object.entries(catalog)
        .filter(([, structure]) => structure.kind === 'muscle' || structure.kind === 'tendon')
        .map(([id]) => id)
        .toSorted()
      expect([...MODEL_MUSCLES_AND_TENDONS]).toEqual(real)
    }
  )
})

describe('the phases', () => {
  it('ties the doses to the races: base, build, taper, a recovery week, Mont-Blanc', () => {
    const kind = (day: string) => phaseOn(DEFAULT_PROGRAM.phases, day)?.kind ?? null
    expect(kind('2026-11-30')).toBe('base')
    expect(kind('2026-12-06')).toBe('base')
    expect(kind('2026-12-07')).toBe('build')
    expect(kind('2027-03-21')).toBe('taper')
    expect(kind('2027-04-04')).toBe('taper')
    expect(kind('2027-04-07')).toBeNull()
    expect(kind('2027-04-12')).toBe('mont-blanc')
    expect(kind('2027-06-20')).toBe('taper')
    expect(kind('2027-06-28')).toBeNull()
  })

  it('goes heavier in the build, halves the sets in the taper, adds eccentric work for Mont-Blanc', () => {
    const dose = (day: string, id: string) =>
      sessionPlan(DEFAULT_PROGRAM, 'A', day, 'gym')?.exercises.find((e) => e.id === id)
    expect(dose('2026-11-30', 'split_squat')).toMatchObject({ sets: 3, reps: 10, tempo: '3-0-3' })
    expect(dose('2026-12-08', 'split_squat')).toMatchObject({ sets: 4, reps: 6, tempo: '3-0-3' })
    expect(dose('2027-03-25', 'split_squat')).toMatchObject({ sets: 2, reps: 6 })
    expect(dose('2027-04-20', 'step_down')).toMatchObject({ sets: 4, reps: 10, tempo: '5-0-1' })
    // Without a dose of its own, the base one; a taper never drops an exercise to 0 sets
    expect(dose('2027-04-20', 'calf_raise_straight')).toMatchObject({ sets: 3, reps: 12 })
    expect(
      sessionPlan(DEFAULT_PROGRAM, 'A', '2027-03-25', 'gym')?.exercises.every((e) => e.sets >= 1)
    ).toBe(true)
    expect(sessionPlan(DEFAULT_PROGRAM, 'A', '2027-04-07', 'gym')).toBeNull()
    expect(sessionPlan(DEFAULT_PROGRAM, 'Z', '2026-11-30', 'gym')).toBeNull()
  })

  it('keeps the pogo hops out of the base phase', () => {
    const ids = (day: string) =>
      sessionPlan(DEFAULT_PROGRAM, 'B', day, 'gym')?.exercises.map((e) => e.id)
    expect(ids('2026-11-30')).not.toContain('pogo_hops')
    expect(ids('2026-12-10')).toContain('pogo_hops')
  })

  it('swaps in the home variant, its name, key and load, the muscles kept', () => {
    const home = sessionPlan(DEFAULT_PROGRAM, 'A', '2026-11-30', 'maison')
    const split = home?.exercises.find((e) => e.id === 'split_squat')
    expect(split).toMatchObject({
      name: 'Fente bulgare, sac à dos lesté',
      instead_of: 'Fente bulgare',
      load: 'Sac à dos de 8–12 kg, 12 répétitions à RPE 7',
    })
    expect(split?.primary).toContain('vastus_medialis_r')
    expect(home?.exercises.find((e) => e.id === 'step_down')?.instead_of).toBeNull()
  })

  it('alternates the sessions', () => {
    expect(nextSession(DEFAULT_PROGRAM, null)).toBe('A')
    expect(nextSession(DEFAULT_PROGRAM, 'A')).toBe('B')
    expect(nextSession(DEFAULT_PROGRAM, 'B')).toBe('A')
    expect(nextSession(DEFAULT_PROGRAM, 'Q')).toBe('A')
  })
})

describe('the session on the watch', () => {
  it('builds a Garmin strength workout: a repeat group per exercise, each side, then the rest', () => {
    const plan = sessionPlan(DEFAULT_PROGRAM, 'A', '2026-11-30', 'gym')
    if (plan === null) throw new Error('no plan')
    const input = strengthWorkout(plan, '2026-11-30', [])
    expect(input.name).toBe('Renfo A - lun 30/11 - Lourd et lent')
    const built = buildWorkout(input)
    if (!built.ok) throw new Error(built.errors.join('\n'))
    expect(built.payload.sportType.sportTypeKey).toBe('strength_training')
    expect(built.steps[0]).toBe(
      '3× [interval DUMBBELL_BULGARIAN_SPLIT_SQUAT 10 reps (gauche · tempo 3-0-3 · RPE 7 : 3 répétitions en réserve), interval DUMBBELL_BULGARIAN_SPLIT_SQUAT 10 reps (droite · tempo 3-0-3 · RPE 7 : 3 répétitions en réserve), rest 2:00]'
    )
    // The catalog's closest entry on the watch, the real exercise in its note
    expect(built.steps[1]).toContain(
      'PARTIAL_SINGLE_LEG_SQUAT 8 reps (Step-down lent (excentrique) · gauche'
    )
    expect(built.steps).toHaveLength(plan.exercises.length)
  })

  it('times a held exercise, and builds every session of every phase and variant', () => {
    const plan = sessionPlan(DEFAULT_PROGRAM, 'B', '2026-12-10', 'maison')
    if (plan === null) throw new Error('no plan')
    expect(workoutName(plan, '2026-12-10')).toBe(
      'Renfo B - jeu 10/12 - Hanches et chaîne postérieure (maison)'
    )
    const built = buildWorkout(strengthWorkout(plan, '2026-12-10', []))
    expect(
      built.ok && built.steps.find((step) => step.includes('SIDE_PLANK_WITH_FEET_ON_BENCH'))
    ).toContain('SIDE_PLANK_WITH_FEET_ON_BENCH 0:30')
    for (const day of ['2026-11-30', '2026-12-10', '2027-03-25', '2027-04-20', '2027-06-20']) {
      for (const id of ['A', 'B']) {
        for (const variant of ['gym', 'maison'] as const) {
          const each = sessionPlan(DEFAULT_PROGRAM, id, day, variant)
          if (each === null) throw new Error(`no plan ${id} ${day}`)
          const result = buildWorkout(strengthWorkout(each, day, []))
          expect(result.ok ? [] : result.errors).toEqual([])
        }
      }
    }
  })
})

// day-type.ts (the nutrition's) counts a strength day as easy: the scheduler relies on it
describe('a strength day for the day type', () => {
  it('is easy, planned or done, even with a quality word nowhere near', () => {
    const planned = {
      name: 'Renfo A - lun 30/11 - Lourd et lent',
      description: 'Base. Tendon rotulien et quadriceps.',
      sport: 'strength_training',
      steps: '3× [interval DUMBBELL_BULGARIAN_SPLIT_SQUAT 10 reps (gauche), rest 2:00]',
      minutes: 50,
      km: null,
    }
    expect(dayType([], [planned], 150)).toMatchObject({ type: 'easy', from: 'planned' })
    expect(
      dayType([{ sport: 'strength_training', minutes: 55, km: null, z45_minutes: 0 }], [], 150)
    ).toMatchObject({ type: 'easy', from: 'done' })
  })
})
