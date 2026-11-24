import { describe, expect, it } from 'vitest'

import {
  epley,
  lastSession,
  progressions,
  sessionIdOf,
  type SetRow,
  type StrengthActivity,
  weeklyCounts,
} from './history.ts'
import { painFlags, workedStructures } from './pain.ts'

const activity = (
  id: number,
  day: string,
  workout_name: string | null = null
): StrengthActivity => ({
  id,
  day,
  name: 'Renforcement musculaire',
  workout_name,
  minutes: 50,
})
const set = (
  activity_id: number,
  idx: number,
  key: string | null,
  reps: number | null,
  weight_kg: number | null,
  duration_s: number | null = null
): SetRow => {
  const [category = null, exercise_name = null] = key === null ? [] : key.split('/')
  return { activity_id, idx, category, exercise_name, reps, weight_kg, duration_s }
}

const SPLIT = 'LUNGE/DUMBBELL_BULGARIAN_SPLIT_SQUAT'
const PLANK = 'PLANK/SIDE_PLANK_WITH_FEET_ON_BENCH'
const names = (key: string) => (key === SPLIT ? 'Fente bulgare' : key)

describe('the history', () => {
  it('counts the sessions per week, empty weeks included, oldest first', () => {
    expect(weeklyCounts(['2026-11-30', '2026-12-03', '2026-12-10'], '2026-12-11', 3)).toEqual([
      { week: '2026-11-23', sessions: 0 },
      { week: '2026-11-30', sessions: 2 },
      { week: '2026-12-07', sessions: 1 },
    ])
    expect(weeklyCounts([], '2026-12-11', 12)).toHaveLength(12)
  })

  it('estimates the one-repetition maximum from 1 to 12 reps only', () => {
    expect(epley(20, 10)).toBe(26.7)
    expect(epley(20, 1)).toBe(20.7)
    expect(epley(20, 13)).toBeNull()
    expect(epley(null, 8)).toBeNull()
    expect(epley(0, 8)).toBeNull()
  })

  it('follows each programme exercise session by session, and any other done twice', () => {
    const activities = [activity(2, '2026-12-03'), activity(1, '2026-11-30')]
    const sets = [
      set(1, 0, SPLIT, 10, 10),
      set(1, 1, SPLIT, 10, 12),
      set(1, 2, PLANK, null, null, 20),
      set(1, 3, 'SQUAT/GOBLET_SQUAT', 10, 16),
      set(2, 0, SPLIT, 8, 14),
      set(2, 1, PLANK, null, null, 25),
      set(2, 2, null, 10, null),
    ]
    const found = progressions(sets, activities, [SPLIT, 'DEADLIFT/ROMANIAN_DEADLIFT'], names)
    expect(found.map((p) => p.key)).toEqual([SPLIT, PLANK])
    expect(found[0]).toMatchObject({ name: 'Fente bulgare' })
    expect(found[0]?.points).toEqual([
      {
        day: '2026-11-30',
        activity_id: 1,
        sets: 2,
        reps: 20,
        top_kg: 12,
        e1rm_kg: 16,
        volume_kg: 220,
        seconds: 0,
      },
      {
        day: '2026-12-03',
        activity_id: 2,
        sets: 1,
        reps: 8,
        top_kg: 14,
        e1rm_kg: 17.7,
        volume_kg: 112,
        seconds: 0,
      },
    ])
    expect(found[1]?.points.map((p) => p.seconds)).toEqual([20, 25])
  })

  it('shows the last session by exercise, in the order done', () => {
    const sets = [
      set(2, 0, SPLIT, 8, 14),
      set(2, 1, SPLIT, 8, 14),
      set(2, 2, PLANK, null, null, 25),
      set(2, 3, SPLIT, 6, 16),
      set(2, 4, null, 10, null),
    ]
    const last = lastSession(sets, [activity(1, '2026-11-30'), activity(2, '2026-12-03')], names)
    expect(last?.activity.id).toBe(2)
    expect(last?.exercises.map((e) => [e.name, e.sets.length])).toEqual([
      ['Fente bulgare', 2],
      [PLANK, 1],
      ['Fente bulgare', 1],
      ['exercice non reconnu', 1],
    ])
    expect(lastSession([], [], names)).toBeNull()
  })

  it('reads the programme session from the workout the watch ran', () => {
    expect(sessionIdOf(activity(1, '2026-12-03', 'Renfo B - jeu 03/12 - Hanches'))).toBe('B')
    expect(sessionIdOf({ name: 'Renfo A - lun 30/11', workout_name: null })).toBe('A')
    expect(sessionIdOf(activity(1, '2026-12-03'))).toBeNull()
  })
})

describe('the pain rule', () => {
  const exercises = [
    {
      id: 'split_squat',
      name: 'Fente bulgare',
      primary: ['rectus_femoris_r', 'vastus_medialis_r'],
      secondary: ['patellar_ligament_r'],
      regression: 'Fente statique',
    },
    {
      id: 'dead_bug',
      name: 'Dead bug',
      primary: ['rectus_abdominis_l'],
      secondary: ['rectus_femoris_r'],
      regression: 'Jambes seules',
    },
  ]

  it('regresses an exercise loading a structure at 3/10 or more, its worst pain kept', () => {
    const flags = painFlags(
      exercises,
      [
        { structure: 'rectus_femoris_r', day: '2026-11-22', pain: 3 },
        { structure: 'rectus_femoris_r', day: '2026-11-24', pain: 2 },
        { structure: 'rectus_femoris_l', day: '2026-11-24', pain: 2 },
      ],
      3
    )
    expect(flags).toEqual([
      {
        exercise_id: 'split_squat',
        exercise: 'Fente bulgare',
        structures: [
          { structure: 'rectus_femoris_r', role: 'primary', pain: 3, day: '2026-11-22' },
        ],
        regression: 'Fente statique',
      },
      {
        exercise_id: 'dead_bug',
        exercise: 'Dead bug',
        structures: [
          { structure: 'rectus_femoris_r', role: 'secondary', pain: 3, day: '2026-11-22' },
        ],
        regression: 'Jambes seules',
      },
    ])
  })

  it('says nothing below the threshold', () => {
    expect(
      painFlags(exercises, [{ structure: 'rectus_femoris_r', day: '2026-11-24', pain: 2 }], 3)
    ).toEqual([])
    expect(painFlags(exercises, [], 3)).toEqual([])
  })

  it('marks what the week works, primary over secondary', () => {
    const worked = workedStructures(exercises)
    expect(worked.get('rectus_femoris_r')).toBe('primary')
    expect(worked.get('patellar_ligament_r')).toBe('secondary')
    expect(worked.get('rectus_abdominis_l')).toBe('primary')
    expect(worked.has('soleus_l')).toBe(false)
  })
})
