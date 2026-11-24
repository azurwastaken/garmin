import { describe, expect, it } from 'vitest'

import type { TrackPoint } from './race-map.tsx'
import {
  followCamera,
  GLIDE_MS,
  middle,
  type Mode,
  type Motion,
  orbitCamera,
  pressed,
  reliefStops,
} from './race-scene.ts'

const COLORS = ['#000001', '#000002', '#000003', '#000004', '#000005']

const altitudesOf = (stops: ReadonlyArray<number | string>) =>
  stops.filter((stop) => typeof stop === 'number')

describe('reliefStops', () => {
  it('spreads the colors in order over the course, a quarter of its span past each end', () => {
    expect(reliefStops([33, 29, 50, 41], COLORS)).toStrictEqual([
      23.75,
      '#000001',
      31.625,
      '#000002',
      39.5,
      '#000003',
      47.375,
      '#000004',
      55.25,
      '#000005',
    ])
  })

  it('counts 20 m of relief on a flat course (a 30 m ramp)', () => {
    const altitudes = altitudesOf(reliefStops([35, 35, 35], COLORS))
    expect(altitudes[0]).toBe(20)
    expect(altitudes.at(-1)).toBe(50)
  })

  it('keeps a mountain course whole', () => {
    const altitudes = altitudesOf(reliefStops([1035, 2525, 1800], COLORS))
    expect(altitudes[0]).toBeLessThan(1035)
    expect(altitudes.at(-1)).toBeGreaterThan(2525)
  })

  it('stays finite and ascending around 0 m without altitudes', () => {
    const altitudes = altitudesOf(reliefStops([], COLORS))
    expect(altitudes).toStrictEqual([-15, -7.5, 0, 7.5, 15])
  })

  it('gives one color one stop', () => {
    expect(reliefStops([10, 30], ['#000001'])).toStrictEqual([5, '#000001'])
  })
})

// A course a point every ~11 m, `north` points northward then `east` points eastward
const course = (north: number, east: number): ReadonlyArray<TrackPoint> => [
  ...Array.from({ length: north }, (_, i): TrackPoint => [6.87, 45.92 + i * 1e-4, 1035, i, null]),
  ...Array.from({ length: east }, (_, i): TrackPoint => [
    6.87 + (i + 1) * 1e-4,
    45.92 + (north - 1) * 1e-4,
    1035,
    north + i,
    null,
  ]),
]

describe('followCamera', () => {
  it('stands on the point, looking along the course', () => {
    const camera = followCamera(course(30, 0), 3)
    expect(camera?.center[0]).toBe(6.87)
    expect(camera?.center[1]).toBeCloseTo(45.9203, 9)
    expect(camera?.bearing).toBeCloseTo(0)
  })

  it('keeps the last step’s heading at the finish', () => {
    const track = course(20, 20)
    const camera = followCamera(track, track.length - 1)
    expect(camera?.center).toStrictEqual([track[39]?.[0], track[39]?.[1]])
    expect(camera?.bearing).toBeCloseTo(90, 0)
  })

  it('has no camera past the end or on a course of one point', () => {
    expect(followCamera(course(30, 0), 30)).toBeNull()
    expect(followCamera(course(1, 0), 0)).toBeNull()
  })
})

describe('orbitCamera', () => {
  const from = [6.8, 45.9] as const
  const to = [6.9, 46] as const

  it('starts where the camera is, at its bearing', () => {
    expect(orbitCamera(from, to, -20, 0)).toStrictEqual({ center: [6.8, 45.9], bearing: -20 })
    expect(orbitCamera(from, to, -20, -16).center).toStrictEqual([6.8, 45.9])
  })

  it('glides to the course’s centre, then stays there while it turns', () => {
    for (const elapsed of [GLIDE_MS, 90_000]) {
      const [lon, lat] = orbitCamera(from, to, -20, elapsed).center
      expect(lon).toBeCloseTo(6.9, 9)
      expect(lat).toBeCloseTo(46, 9)
    }
    expect(orbitCamera(from, to, -20, 90_000).bearing).toBeCloseTo(340, 9)
  })
})

describe('pressed', () => {
  it.each<[Motion, Mode, boolean, Motion | 'step']>([
    ['still', 'flight', false, 'flight'],
    ['still', 'orbit', false, 'orbit'],
    ['flight', 'flight', false, 'still'],
    ['flight', 'orbit', false, 'orbit'],
    ['orbit', 'orbit', false, 'still'],
    ['orbit', 'flight', false, 'flight'],
    ['still', 'flight', true, 'step'],
    ['still', 'orbit', true, 'step'],
    ['flight', 'flight', true, 'still'],
    ['flight', 'orbit', true, 'still'],
    ['orbit', 'orbit', true, 'still'],
    ['orbit', 'flight', true, 'still'],
  ])('%s, %s pressed (reduced: %s) → %s', (motion, mode, reduced, next) => {
    expect(pressed(motion, mode, reduced)).toBe(next)
  })
})

describe('middle', () => {
  it('is the centre of a box', () => {
    expect(middle([2, 48, 3, 49])).toStrictEqual([2.5, 48.5])
  })
})
