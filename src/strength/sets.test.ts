import { expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import { describe } from 'vitest'

import { exerciseSetsAnswer, fitRun } from '../../test/fixtures.ts'
import { parseFit } from '../fit.ts'

import { catalogKey, connectSets, connectWeightKg } from './sets.ts'

describe('the catalog’s keys', () => {
  it('spells a FIT profile name as Garmin’s catalog does', () => {
    expect(catalogKey('dumbbellBulgarianSplitSquat')).toBe('DUMBBELL_BULGARIAN_SPLIT_SQUAT')
    expect(catalogKey('hipRaise')).toBe('HIP_RAISE')
    expect(catalogKey('3WayCalfRaise')).toBe('_3_WAY_CALF_RAISE')
    expect(catalogKey('45DegreePlank')).toBe('_45_DEGREE_PLANK')
    expect(catalogKey('weightedHangingLSit')).toBe('WEIGHTED_HANGING_L_SIT')
    expect(catalogKey('bandedExercises')).toBe('BANDED_EXERCISES')
  })
})

describe('Connect’s exercise sets', () => {
  it('keeps the active sets, the likeliest exercise, the weight in kg', () => {
    expect(connectSets(exerciseSetsAnswer(7001))).toEqual([
      {
        idx: 0,
        start_time: '2026-11-30T18:02:13.0',
        category: 'LUNGE',
        exercise_name: 'DUMBBELL_BULGARIAN_SPLIT_SQUAT',
        reps: 10,
        weight_kg: 12,
        duration_s: 48.2,
      },
      {
        idx: 1,
        start_time: '2026-11-30T18:05:01.0',
        category: 'PLANK',
        exercise_name: 'SIDE_PLANK_WITH_FEET_ON_BENCH',
        reps: null,
        weight_kg: null,
        duration_s: 20.4,
      },
      {
        idx: 2,
        start_time: '2026-11-30T18:06:01.0',
        category: null,
        exercise_name: null,
        reps: 8,
        weight_kg: null,
        duration_s: 30,
      },
    ])
  })

  it('reads grams as kg, nothing for no load', () => {
    expect(connectWeightKg(12_500)).toBe(12.5)
    expect(connectWeightKg(0)).toBeNull()
    expect(connectWeightKg(-1)).toBeNull()
    expect(connectWeightKg(null)).toBeNull()
  })

  it('is not an answer without its sets', () => {
    expect(connectSets({ exerciseSets: null })).toEqual([])
    expect(connectSets([])).toBeNull()
    expect(connectSets({ activityId: 1 })).toBeNull()
  })
})

describe('the FIT file’s sets', () => {
  it.effect('reads the watch’s sets: category, exercise, reps, kg, seconds; rests left out', () =>
    Effect.gen(function* () {
      const fit = yield* parseFit(
        fitRun({
          sport: 'training',
          sets: [
            // lunge 7: barbellBulgarianSplitSquat; calf raise 0: 3WayCalfRaise
            { category: 'lunge', subtype: 7, reps: 10, weight: 12.5, duration: 48 },
            { category: 'calfRaise', subtype: 0, reps: 15, duration: 40 },
            { category: 'plank', subtype: 9999, duration: 30 },
          ],
        })
      )
      expect(fit.sets).toEqual([
        {
          idx: 0,
          start_time: '2026-10-31T06:13:40.000Z',
          category: 'LUNGE',
          exercise_name: 'BARBELL_BULGARIAN_SPLIT_SQUAT',
          reps: 10,
          weight_kg: 12.5,
          duration_s: 48,
        },
        {
          idx: 1,
          start_time: '2026-10-31T06:15:58.000Z',
          category: 'CALF_RAISE',
          exercise_name: '_3_WAY_CALF_RAISE',
          reps: 15,
          weight_kg: null,
          duration_s: 40,
        },
        {
          idx: 2,
          start_time: '2026-10-31T06:18:08.000Z',
          category: 'PLANK',
          exercise_name: null,
          reps: null,
          weight_kg: null,
          duration_s: 30,
        },
      ])
      // A run has none
      expect((yield* parseFit(fitRun())).sets).toEqual([])
    })
  )
})
