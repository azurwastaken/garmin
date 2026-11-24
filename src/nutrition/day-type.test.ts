import { describe, expect, it } from 'vitest'

import { buildWorkout, type WorkoutInput } from '../garmin/workout-builder.ts'

import { type DoneSession, dayType, type PlannedSession, readSteps } from './day-type.ts'

// describeStep's lines as the builder writes them: the reader must give each step back
const stepsOf = (input: WorkoutInput) => {
  const built = buildWorkout(input)
  if (!built.ok) throw new Error(built.errors.join('; '))
  return built.steps.join('\n')
}

const planned = (session: Partial<PlannedSession>): PlannedSession => ({
  name: 'Footing',
  description: null,
  sport: 'running',
  steps: null,
  minutes: 40,
  km: null,
  ...session,
})

const done = (session: Partial<DoneSession>): DoneSession => ({
  sport: 'running',
  minutes: 40,
  km: 7,
  z45_minutes: 0,
  ...session,
})

describe('readSteps', () => {
  it('reads back every step the builder writes, a repeat group’s flattened', () => {
    const run = stepsOf({
      name: 'Test',
      sport: 'running',
      steps: [
        { kind: 'warmup', duration: '10:00', hr: { low: 120, high: 150 } },
        { duration: '1:05:00', hr: { low: 165, high: 175 } },
        { duration: '3:00', pace: { slow: '5:45', fast: '5:35' } },
        { distance_m: 1500 },
        {
          repeat: 4,
          steps: [
            { distance_m: 400, note: 'Vite, mais relâché' },
            { kind: 'recovery', duration: 90 },
          ],
        },
        {
          repeat: 3,
          steps: [
            { duration: 20, note: 'Stride' },
            { kind: 'recovery', duration: 40 },
          ],
        },
      ],
    })
    expect(readSteps(run)).toEqual([
      {
        kind: 'warmup',
        seconds: 600,
        metres: null,
        target: { kind: 'hr', low: 120, high: 150 },
        repeated: false,
      },
      {
        kind: 'interval',
        seconds: 3900,
        metres: null,
        target: { kind: 'hr', low: 165, high: 175 },
        repeated: false,
      },
      { kind: 'interval', seconds: 180, metres: null, target: { kind: 'pace' }, repeated: false },
      { kind: 'interval', seconds: null, metres: 1500, target: null, repeated: false },
      { kind: 'interval', seconds: null, metres: 400, target: null, repeated: true },
      { kind: 'recovery', seconds: 90, metres: null, target: null, repeated: true },
      { kind: 'interval', seconds: 20, metres: null, target: null, repeated: true },
      { kind: 'recovery', seconds: 40, metres: null, target: null, repeated: true },
    ])
    const strength = stepsOf({
      name: 'Gainage',
      sport: 'strength_training',
      steps: [{ category: 'PLANK', exercise_name: 'SIDE_PLANK', duration: '1:00' }],
    })
    expect(readSteps(strength)).toEqual([
      { kind: 'interval', seconds: 60, metres: null, target: null, repeated: false },
    ])
  })

  it('reads the lines Garmin Connect alone writes, and leaves out what it cannot read', () => {
    const cases: ReadonlyArray<readonly [string, ReadonlyArray<object>]> = [
      ['interval 10:00 HR zone 4', [{ seconds: 600, target: { kind: 'hr-zone', zone: 4 } }]],
      ['interval 10:00 HR zone ?', [{ seconds: 600, target: null }]],
      ['interval lap button', [{ seconds: null, metres: null }]],
      ['?× [interval 1.5 km, recovery 1:30]', [{ metres: 1500, repeated: true }, {}]],
      [
        '3× [2× [interval 1:00 pace 4:30/km-4:40/km, recovery 1:00], rest 2:00]',
        [{ seconds: 60, target: { kind: 'pace' }, repeated: true }, { kind: 'recovery' }, {}],
      ],
      [
        'warmup 5:00 (Marche rapide, puis trottiner)\ninterval 25:00 HR 125-150 (Petits pas, cadence 165+)',
        [
          { kind: 'warmup', seconds: 300 },
          { seconds: 1500, repeated: false },
        ],
      ],
      ['interval 10 reps', [{ seconds: null, metres: null }]],
      ['du texte libre', []],
    ]
    for (const [steps, expected] of cases) {
      const read = readSteps(steps)
      expect(read, steps).toHaveLength(expected.length)
      expected.forEach((step, index) => expect(read[index], steps).toMatchObject(step))
    }
  })
})

describe('dayType', () => {
  const FLOOR = 160
  const plannedDay = (session: Partial<PlannedSession>, floor: number | null = FLOOR) =>
    dayType([], [planned(session)], floor).type

  it('rests on a day with nothing planned or done', () => {
    expect(dayType([], [], FLOOR)).toEqual({
      type: 'rest',
      from: 'nothing',
      reason: 'rien de prévu ni de fait',
    })
  })

  it('reads quality in a planned session’s HR targets against the zone-4 floor, every step', () => {
    const cases: ReadonlyArray<readonly [string, number | null, string]> = [
      // The step type `interval` is every main step's: no quality by itself
      ['interval 25:00 HR 125-150', FLOOR, 'easy'],
      ['warmup 15:00 HR 120-140\ninterval 20:00 HR 160-170\ncooldown 10:00', FLOOR, 'quality'],
      // 160 is zone 3's top bound: a target up to it stays in zone 3
      ['interval 20:00 HR 140-160', FLOOR, 'easy'],
      ['interval 20:00 HR 150-165', null, 'easy'],
      ['interval 10:00 HR zone 4', FLOOR, 'quality'],
      ['interval 10:00 HR zone 3', FLOOR, 'easy'],
    ]
    for (const [steps, floor, type] of cases) expect(plannedDay({ steps }, floor), steps).toBe(type)
  })

  it('reads quality in repetitions, never in strides nor in a repeated easy HR target', () => {
    const strides = stepsOf({
      name: "Test - Easy 40' + 3 strides",
      sport: 'running',
      steps: [
        { duration: '37:00', hr: { low: 120, high: 150 } },
        {
          repeat: 3,
          steps: [
            { duration: 20, note: 'Stride' },
            { kind: 'recovery', duration: '40s', note: 'Walk back' },
          ],
        },
      ],
    })
    const cases: ReadonlyArray<readonly [string, string]> = [
      [strides, 'easy'],
      ['?× [interval 1:00]', 'quality'],
      ['6× [interval 400 m, recovery 1:30]', 'quality'],
      [
        `${strides}\n6× [interval 3:00 pace 5:35/km-5:45/km, recovery 1:30]`,
        // Every group read, not the first
        'quality',
      ],
      ['5× [interval 6:00 HR 125-150, recovery 1:00]', 'easy'],
      ['5× [interval 3:00 HR 165-172, recovery 2:00]', 'quality'],
    ]
    for (const [steps, type] of cases) expect(plannedDay({ steps }), steps).toBe(type)
  })

  it('reads quality words in the name or the description, never a strength circuit’s steps', () => {
    expect(plannedDay({ name: "Seuil 3×10'" })).toBe('quality')
    expect(plannedDay({ description: 'Fractionné court sur piste' })).toBe('quality')
    expect(
      plannedDay({ sport: 'strength_training', steps: '3× [interval SIDE_PLANK 1:00, rest 0:30]' })
    ).toBe('easy')
  })

  it('makes a long day of 75 minutes or 15 km of running, planned or done', () => {
    expect(plannedDay({ minutes: 84 })).toBe('long')
    expect(plannedDay({ minutes: 70, km: 16 })).toBe('long')
    expect(plannedDay({ sport: 'cycling', minutes: 120 })).toBe('easy')
    expect(dayType([], [planned({ minutes: 40 }), planned({ minutes: 40 })], FLOOR).type).toBe(
      'long'
    )
    expect(dayType([done({ minutes: 122, km: 21.4, z45_minutes: 114 })], [], FLOOR)).toEqual({
      type: 'long',
      from: 'done',
      reason: '122 min et 21,4 km de course',
    })
  })

  it('judges a done day by its time in zones 4–5, any sport, and replaces the plan with it', () => {
    const cases: ReadonlyArray<readonly [DoneSession, string]> = [
      [done({ sport: 'treadmill_running', minutes: 35, km: 5.5, z45_minutes: 22 }), 'quality'],
      [done({ minutes: 31, km: 5.4, z45_minutes: 14 }), 'easy'],
      [done({ sport: 'cycling', minutes: 60, km: 25, z45_minutes: 22 }), 'quality'],
      [done({ sport: 'cycling', minutes: 120, km: 50, z45_minutes: 5 }), 'easy'],
    ]
    for (const [session, type] of cases) expect(dayType([session], [], FLOOR).type).toBe(type)
    const plannedLong = planned({ minutes: 90 })
    expect(dayType([done({ minutes: 30 })], [plannedLong], FLOOR)).toMatchObject({
      type: 'easy',
      from: 'done',
    })
  })
})
