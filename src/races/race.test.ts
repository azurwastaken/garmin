import { Result, Schema } from 'effect'
import { describe, expect, it } from 'vitest'

import { gpxText, syntheticCourse } from '../../test/races.ts'

import { courseOf, segmentCourse } from './course.ts'
import { parseGpx } from './gpx.ts'
import {
  clockOf,
  FactsInputSchema,
  HHMMSchema,
  planFile,
  RaceFactsJson,
  raceView,
  SlugSchema,
  slugOf,
} from './race.ts'

const course = (() => {
  const fixes = parseGpx(
    gpxText(
      syntheticCourse([
        [3000, 0],
        [3000, 300],
        [3000, -300],
      ]).points
    )
  )
  const made = Result.isSuccess(fixes) ? courseOf(fixes.success) : null
  if (made === null) throw new Error('no course')
  return made
})()
const segments = segmentCourse(course)

const facts = Schema.decodeUnknownSync(RaceFactsJson)({
  name: 'Trail test',
  date: '2027-09-25',
  start_time: '06:00',
  aid_stations: [{ km: 4.5, name: 'Flégère', offers: 'eau, coca' }],
  cutoffs: [{ km: 6, time: '07:00', name: 'Col' }],
  elevation: { source: 'gpx' },
})
const reference = {
  id: 1,
  day: '2026-11-15',
  name: 'Semi',
  moving_s: 7200,
  distance_m: 21_000,
  equivalent_m: 21_000,
}
const slug = SlugSchema.make('trail-test-2027')

describe('the race files', () => {
  it('names a race by its name and year', () => {
    expect(slugOf('Marathon du Mont-Blanc', '2027-06-27')).toBe('marathon-du-mont-blanc-2027')
    expect(slugOf('Trail des Aiguilles Rouges 2027', '2027-09-25')).toBe(
      'trail-des-aiguilles-rouges-2027'
    )
    expect(slugOf('  Écotrail — Paris!  ', '2027-03-20')).toBe('ecotrail-paris-2027')
    expect(slugOf('—', '2027-03-20')).toBeNull()
    expect(
      Schema.decodeUnknownExit(FactsInputSchema)({ name: '東京', date: '2027-03-01' })._tag
    ).toBe('Failure')
  })

  it('refuses a facts file whose DEM has no attribution', () => {
    const decode = Schema.decodeUnknownExit(RaceFactsJson)
    const base = { name: 'X', date: '2027-01-01' }
    expect(decode({ ...base, elevation: { source: 'dem' } })._tag).toBe('Failure')
    expect(decode({ ...base, elevation: { source: 'dem', attribution: 'IGN' } })._tag).toBe(
      'Success'
    )
  })

  it("stamps the plan's entries with their segment's km, and refuses a wrong one", () => {
    const plan = planFile(
      { carbs_g_per_h: 70, segments: [{ segment: 2, pace: "9'30/km", notes: 'marche active' }] },
      segments
    )
    expect(plan).toEqual(
      Result.succeed({
        carbs_g_per_h: 70,
        segments: [
          {
            segment: 2,
            notes: 'marche active',
            from_km: Number(segments[1]?.from_km.toFixed(3)),
            to_km: Number(segments[1]?.to_km.toFixed(3)),
            pace_s: 570,
          },
        ],
      })
    )
    expect(planFile({ segments: [{ segment: 9 }] }, segments)).toEqual(
      Result.fail('segment 9 : le parcours en a 3')
    )
    expect(planFile({ segments: [{ segment: 1 }, { segment: 1 }] }, segments)).toEqual(
      Result.fail('segment 1 donné deux fois')
    )
    expect(planFile({ segments: [{ segment: 1, pace: 'vite' }] }, segments)).toEqual(
      Result.fail('segment 1 : allure "vite" illisible')
    )
  })

  it('writes clock times, past midnight too', () => {
    const at = HHMMSchema.make('22:30')
    expect(clockOf(at, 3600)).toBe('23:30')
    expect(clockOf(at, 7200)).toBe('00:30 +1 j')
  })
})

describe('raceView', () => {
  it('stands without a reference run: segments and plan, no times', () => {
    const view = raceView({ slug, facts, plan: null, course, reference: null })
    expect(view).toMatchObject({
      km: 9,
      d_plus: expect.any(Number),
      planned: false,
      prediction: null,
    })
    expect(view.segments.map((s) => s.kind)).toEqual(['flat', 'climb', 'descent'])
  })

  it('times the segments, the aid station and the cutoff with its margin', () => {
    const plan = planFile(
      { segments: [{ segment: 1, pace: 300, hr: { low: 150, high: 160 } }] },
      segments
    )
    if (Result.isFailure(plan)) throw new Error(plan.failure)
    const view = raceView({ slug, facts, plan: plan.success, course, reference })
    const prediction = view.prediction
    if (prediction === null) throw new Error('no prediction')
    expect(view.segments[0]?.plan?.pace_s).toBe(300)
    // The planned 5'00/km over the flat (3 km, its end a step early for the smoothing)
    expect(
      Math.abs((prediction.segments[0]?.time_s ?? 0) - 300 * (view.segments[0]?.km ?? 0))
    ).toBeLessThanOrEqual(1)
    expect(prediction.segments[0]?.clock).toEqual({ start: '06:00', end: '06:15' })
    expect(prediction.total_s).toBe(prediction.segments.reduce((sum, s) => sum + s.time_s, 0))
    const [aid, cutoff] = prediction.passings
    expect(aid).toMatchObject({ kind: 'aid', km: 4.5, name: 'Flégère', offers: 'eau, coca' })
    if (cutoff?.kind !== 'cutoff' || cutoff.timing === null) throw new Error('no cutoff timing')
    expect(cutoff.timing.margin_s).toBe(3600 - cutoff.at_s)
    expect(prediction.gels.length).toBe(Math.ceil(prediction.total_s / 1500) - 1)
  })

  it("warns of a plan entry whose segment moved, and doesn't apply it", () => {
    const view = raceView({
      slug,
      facts,
      plan: { segments: [{ segment: 1, from_km: 0, to_km: 2.5, pace_s: 300 }] },
      course,
      reference,
    })
    expect(view.segments[0]?.plan).toBeNull()
    expect(view.warnings).toEqual([
      'Plan du segment 1 (km 0–2.5) : le parcours a changé, non appliqué.',
    ])
  })
})
