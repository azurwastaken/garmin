import { describe, expect, it, layer } from '@effect/vitest'
import { Effect, Layer } from 'effect'

import { fitRun, put, testLayer } from '../../test/fixtures.ts'
import { addDays, monthEnd, parisToday } from '../days.ts'
import { Ingest, Storage } from '../ingest.ts'

import { Nutrition, nutritionView } from './nutrition.ts'
import { DEFAULT_PLAN } from './plan.ts'
import { dailyWeighIns } from './trend.ts'

const TestLayer = testLayer(Nutrition.layer.pipe(Layer.provideMerge(Storage)))

// Garmin weigh-ins, in Connect's shape: a file a month
const putWeighIns = (weighIns: ReadonlyArray<readonly [string, number]>) =>
  Effect.forEach(
    Map.groupBy(weighIns, ([day]) => day.slice(0, 7)),
    ([month, inMonth]) =>
      put(`connect/body/${month}.json`, {
        startDate: `${month}-01`,
        endDate: monthEnd(`${month}-01`),
        dateWeightList: inMonth.map(([day, kg]) => ({
          calendarDate: day,
          timestampGMT: Date.parse(`${day}T06:00:00Z`),
          weight: kg * 1000,
          sourceType: 'INDEX_SCALE',
        })),
      }),
    { discard: true }
  )

describe('nutritionView', () => {
  it('judges the trend in the phase today falls in, from that phase’s start', () => {
    const view = nutritionView({
      plan: DEFAULT_PLAN,
      today: '2026-11-24',
      span: 90,
      weighIns: dailyWeighIns(
        ['2026-11-13', '2026-11-16', '2026-11-18', '2026-11-24'].map((day) => ({
          time: `${day}T06:00:00.000Z`,
          day,
          weight_kg: 71,
          body_fat_pct: null,
          muscle_mass_kg: null,
        }))
      ),
      done: [],
      planned: [],
      z4FloorBpm: null,
    })
    expect(view).toMatchObject({
      day: { type: 'rest' },
      target: { kcal: 1900 },
      phase: { kind: 'deficit', from: '2026-11-19' },
      trend: { kind: 'too-few', from: '2026-11-19', weigh_ins: 1 },
      status: 'too-few',
      latest: { day: '2026-11-24' },
    })
    expect(view.days).toHaveLength(90)
  })
})

// The real clock: the page's days end today
layer(TestLayer, { excludeTestServices: true })('Nutrition', (it) => {
  it.effect(
    'reads the zone-4 floor of the latest run, the day’s plan, and the weigh-ins the corridor needs',
    () =>
      Effect.gen(function* () {
        const today = yield* parisToday
        // Yesterday's run: its zone tops [100, 120, 140, 155, 170, 185], zone 4 from 155
        yield* put(
          'fit/2026/42.fit',
          fitRun({ start: new Date(`${addDays(today, -1)}T06:00:00Z`) })
        )
        // Today's plan: an HR target up to 160, into zone 4 (zone 5's 170 would make it easy)
        yield* put(`connect/calendar/${today.slice(0, 7)}.json`, {
          calendarItems: [
            { id: 1, itemType: 'workout', title: 'Footing', date: today, workoutId: 9 },
          ],
        })
        yield* put('connect/workouts/9.json', {
          workoutId: 9,
          workoutName: 'Footing',
          sportType: { sportTypeKey: 'running' },
          estimatedDurationInSecs: 1800,
          workoutSegments: [
            {
              workoutSteps: [
                {
                  type: 'ExecutableStepDTO',
                  stepType: { stepTypeKey: 'interval' },
                  endCondition: { conditionTypeKey: 'time' },
                  endConditionValue: 1200,
                  targetType: { workoutTargetTypeKey: 'heart.rate.zone' },
                  targetValueOne: 150,
                  targetValueTwo: 160,
                },
              ],
            },
          ],
        })
        // A deficit begun 120 days ago, older than the 90 days shown: its corridor starts from the
        // mean of the week before it
        const start = addDays(today, -120)
        yield* put('nutrition/plan.json', {
          ...DEFAULT_PLAN,
          phases: [{ kind: 'deficit', from: start, to: addDays(today, 30) }],
        })
        yield* putWeighIns([
          [addDays(start, -3), 72],
          [start, 71],
          [today, 69.5],
        ])
        yield* Ingest.use((ingest) => ingest.run())

        const view = yield* Nutrition.use((nutrition) => nutrition.view(90))
        // The floor is $[3]: 140 or easy would be another index
        expect(view.day).toEqual({
          type: 'quality',
          from: 'planned',
          reason: 'cible FC 150-160 au-dessus de 155 (zone 4)',
        })
        expect(view.target.kcal).toBe(2850)
        expect(view.days).toHaveLength(90)
        // 71.5 on the deficit's first day, 120 days (17 weeks and 1 day) of 0.3 to 0.5 kg a week
        const weeks = 120 / 7
        expect(view.days.at(-1)).toMatchObject({
          day: today,
          weight_kg: 69.5,
          lo: Number((71.5 - 0.5 * weeks).toFixed(2)),
          hi: Number((71.5 - 0.3 * weeks).toFixed(2)),
        })
        expect(view.latest).toMatchObject({ day: today, weight_kg: 69.5 })
      })
  )
})
