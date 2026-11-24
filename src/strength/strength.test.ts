import { describe, expect, it } from 'vitest'

import { anatomyCatalog } from '../../test/fixtures.ts'

import { DEFAULT_PROGRAM } from './program.ts'
import { labelFrom, proposalOf, proposeWeek, unknownStructures, weekDayOf } from './strength.ts'

const PAIN = [{ structure: 'rectus_femoris_r', day: '2026-11-22', pain: 3 }]

const propose = (week: string, change: Partial<Parameters<typeof proposeWeek>[0]> = {}) =>
  proposeWeek({
    program: DEFAULT_PROGRAM,
    week,
    today: '2026-11-24',
    variant: 'gym',
    days: [],
    lastBefore: () => null,
    pains: [],
    labelOf: (id) => id,
    ...change,
  })

describe('the week’s proposal', () => {
  it('follows the programme’s order after the last session named', () => {
    expect(propose('2026-11-30').sessions.map((s) => [s.day, s.session])).toEqual([
      ['2026-11-30', 'A'],
      ['2026-12-03', 'B'],
    ])
    expect(propose('2026-11-30', { lastBefore: () => 'A' }).sessions.map((s) => s.session)).toEqual(
      ['B', 'A']
    )
  })

  it('carries the pain rule into the session and onto the watch', () => {
    const [first] = propose('2026-11-30', {
      pains: PAIN,
      labelOf: (id) => (id === 'rectus_femoris_r' ? 'droit fémoral, côté droit' : id),
    }).sessions
    expect(first?.pain.map((flag) => flag.exercise_id)).toEqual(['split_squat', 'step_down'])
    expect(first?.workout.description).toContain(
      'Règle des 3/10 (droit fémoral, côté droit 3/10) : Fente bulgare → Fente statique au poids du corps'
    )
  })

  it('places nothing in the recovery week after the marathon', () => {
    const recovery = propose('2027-04-05', { today: '2027-04-01' })
    expect(recovery.placement.slots).toHaveLength(2)
    expect(recovery.sessions).toEqual([])
  })

  it('answers the coach without the plans’ internals', () => {
    const answer = proposalOf(propose('2026-11-30', { variant: 'maison' }))
    expect(answer.sessions[0]).toMatchObject({
      day: '2026-11-30',
      session: 'A',
      phase: 'Base : réapprendre les mouvements',
      workout_name: 'Renfo A - lun 30/11 - Lourd et lent (maison)',
    })
    expect(answer.sessions[0]?.exercises[0]).toMatchObject({
      id: 'split_squat',
      name: 'Fente bulgare, sac à dos lesté',
      sets: 3,
      reps: 10,
    })
  })
})

describe('a day for the scheduler', () => {
  const run = {
    name: "Plan - mar 24/11 - Reprise 25' EF < 150",
    description: null,
    sport: 'running',
    steps: 'interval 25:00 HR 125-150',
    minutes: 30,
    km: null,
  }

  it('warns of a calendar run still to do, not of one a run done replaced', () => {
    expect(weekDayOf('2026-11-24', [], [run], 160)).toMatchObject({
      type: 'easy',
      calendar: [run.name],
      strength: false,
    })
    const treadmill = { sport: 'treadmill_running', minutes: 33, km: 4.3, z45_minutes: 0 }
    expect(weekDayOf('2026-11-24', [treadmill], [run], 160)).toMatchObject({
      type: 'easy',
      calendar: [],
    })
  })

  it('judges the runs alone, and marks a strength session done or planned', () => {
    const renfo = { ...run, name: 'Renfo A', sport: 'strength_training', steps: null }
    expect(weekDayOf('2026-11-30', [], [renfo], 160)).toMatchObject({
      type: 'rest',
      calendar: ['Renfo A'],
      strength: true,
    })
    expect(
      weekDayOf(
        '2026-11-30',
        [{ sport: 'strength_training', minutes: 50, km: null, z45_minutes: 0 }],
        [],
        160
      )
    ).toMatchObject({ type: 'rest', strength: true })
  })
})

describe('the live anatomy model', () => {
  it('refuses a programme muscle its catalog lacks, with the closest ids; none without it', () => {
    expect(unknownStructures(DEFAULT_PROGRAM, anatomyCatalog)).toContain(
      'split_squat : vastus_medialis_l inconnu'
    )
    expect(unknownStructures(DEFAULT_PROGRAM, null)).toBeNull()
    const knee = {
      ...DEFAULT_PROGRAM,
      exercises: [
        {
          ...DEFAULT_PROGRAM.exercises[0],
          id: 'split_squat',
          primary: ['vastus_lateralis_l', 'vastus_lateralis_r'],
          secondary: [],
        },
      ],
    }
    expect(unknownStructures(knee as typeof DEFAULT_PROGRAM, anatomyCatalog)).toBeNull()
  })

  it('names a structure in French when it can', () => {
    expect(labelFrom(anatomyCatalog)('vastus_lateralis_r')).toContain('côté droit')
    expect(labelFrom(null)('vastus_lateralis_r')).toBe('vastus_lateralis_r')
  })
})
