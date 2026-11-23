import { Result } from 'effect'
import { describe, expect, it } from 'vitest'

import { gpxText, syntheticCourse } from '../../test/races.ts'

import {
  courseOf,
  cumulative,
  equivalentM,
  fillGaps,
  gapFactor,
  haversine,
  profileOf,
  segmentCourse,
  STEP_M,
  totals,
} from './course.ts'
import { parseGpx } from './gpx.ts'

const within = (value: number, expected: number, ratio: number) =>
  expect(Math.abs(value - expected)).toBeLessThanOrEqual(Math.abs(expected) * ratio)

// A Chamonix-like course: valley, a long climb, a steep descent, a short wall, a long descent
const chamonix = syntheticCourse(
  [
    [2000, 10],
    [6000, 900],
    [4000, -620],
    [600, 60],
    [1500, 15],
    [7000, -365],
  ],
  { noise: 1.5 }
)

const courseFrom = (points: ReturnType<typeof syntheticCourse>['points']) => {
  const fixes = parseGpx(gpxText(points))
  if (Result.isFailure(fixes)) throw new Error(fixes.failure)
  const course = courseOf(fixes.success)
  if (course === null) throw new Error('no course')
  return course
}

describe('the course', () => {
  it('measures a degree of latitude as 111.2 km', () => {
    within(haversine({ lat: 45, lon: 6.87 }, { lat: 46, lon: 6.87 }), 111_195, 0.001)
    expect(cumulative([{ lat: 45, lon: 6 }])).toEqual([0])
  })

  it('fills missing altitudes along the distance, not the index', () => {
    expect(fillGaps([0, 10, 100], [100, null, 200])).toEqual([100, 110, 200])
    expect(fillGaps([0, 10, 20], [null, 50, null])).toEqual([50, 50, 50])
    expect(fillGaps([0, 10], [null, null])).toBeNull()
  })

  it('resamples every 25 m to the finish, repeated points dropped', () => {
    const profile = profileOf([0, 0, 30, 30, 60], [100, 100, 103, 103, 106])
    expect(profile?.map((p) => p.d)).toEqual([0, 25, 50, 60])
    expect(profileOf([0, 0], [1, 1])).toBeNull()
    expect(profileOf([0, 100], [null, null])).toBeNull()
  })

  it("lands within 2 % of a Chamonix course's distance and D+, noise and all", () => {
    const course = courseFrom(chamonix.points)
    const all = totals(course)
    within(all.km * 1000, chamonix.distance, 0.02)
    within(all.d_plus, chamonix.up, 0.02)
    within(all.d_minus, chamonix.down, 0.02)
    expect(
      course.every(
        (p, i) => i === course.length - 1 || (course[i + 1]?.d ?? 0) - p.d <= STEP_M + 1e-6
      )
    ).toBe(true)
  })

  it('cuts it into segments that tile it exactly', () => {
    const course = courseFrom(chamonix.points)
    const segments = segmentCourse(course)
    const all = totals(course)
    expect(segments[0]?.from).toBe(0)
    expect(segments.at(-1)?.to).toBe(course.length - 1)
    for (const [i, segment] of segments.entries()) {
      expect(segment.index).toBe(i + 1)
      if (i > 0) expect(segment.from).toBe(segments[i - 1]?.to)
      expect(segment.km).toBeLessThanOrEqual(5 + 1e-9)
      expect(segment.km_effort).toBeCloseTo(segment.km + segment.d_plus / 100, 9)
    }
    const sum = (key: 'km' | 'd_plus' | 'd_minus') => segments.reduce((s, x) => s + x[key], 0)
    expect(sum('km')).toBeCloseTo(all.km, 9)
    expect(sum('d_plus')).toBeCloseTo(all.d_plus, 9)
    expect(sum('d_minus')).toBeCloseTo(all.d_minus, 9)
    // The legs: flat, the climb (in two, over 5 km), the descent, the wall, a 1 % flat, the
    // descent (in two)
    expect(segments.map((s) => s.kind)).toEqual([
      'flat',
      'climb',
      'climb',
      'descent',
      'climb',
      'flat',
      'descent',
      'descent',
    ])
  })

  it('never keeps a tiny segment, but keeps a long flat between climbs', () => {
    const course = courseFrom(
      syntheticCourse([
        [1000, 100],
        [200, 0],
        [1000, 100],
        [3000, 0],
        [1000, 100],
      ]).points
    )
    const segments = segmentCourse(course)
    expect(segments.map((s) => s.kind)).toEqual(['climb', 'flat', 'climb'])
    // The 200 m landing joins the climbs; the smoothing moves each boundary by a step or two
    for (const [segment, km] of segments.map((s, i) => [s, [2.2, 3, 1][i] ?? 0] as const)) {
      expect(Math.abs(segment.km - km)).toBeLessThanOrEqual(0.1)
    }
  })

  it('cuts a flat road race into parts of 5 km at most', () => {
    const course = courseFrom(syntheticCourse([[21_100, 0]]).points)
    const segments = segmentCourse(course)
    expect(segments.map((s) => s.kind)).toEqual(['flat', 'flat', 'flat', 'flat', 'flat'])
    for (const s of segments) within(s.km, 21.1 / 5, 0.01)
  })
})

describe('the grade-adjusted effort', () => {
  it("hits Strava's published anchors within the stated tolerance", () => {
    expect(gapFactor(0)).toBe(1)
    const grades = Array.from({ length: 201 }, (_, i) => -10 + i * 0.01)
    const minimum = grades.reduce((best, g) => (gapFactor(g) < gapFactor(best) ? g : best))
    expect(minimum).toBeGreaterThanOrEqual(-10)
    expect(minimum).toBeLessThanOrEqual(-8)
    within(gapFactor(minimum), 0.88, 0.015 / 0.88)
    expect(gapFactor(-18)).toBeGreaterThanOrEqual(0.97)
    expect(gapFactor(-18)).toBeLessThanOrEqual(1.05)
    // Uphill costs more, clamped past ±35 %
    expect(gapFactor(10)).toBeGreaterThan(1.3)
    expect(gapFactor(60)).toBe(gapFactor(35))
  })

  it('makes a flat course its own distance, a hilly one longer', () => {
    const flat = profileOf([0, 10_000], [50, 50])
    const hilly = profileOf([0, 5000, 10_000], [50, 550, 50])
    if (flat === null || hilly === null) throw new Error('no profile')
    expect(equivalentM(flat)).toBeCloseTo(10_000, 6)
    expect(equivalentM(hilly)).toBeGreaterThan(11_000)
  })
})
