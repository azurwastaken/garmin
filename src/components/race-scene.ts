import type { Bounds } from '../races/terrarium.ts'

import type { TrackPoint } from './race-map.tsx'

// The race map's ground and camera, without a map: the relief's colors and their stops over the
// course's altitudes, the flight's and the orbit's cameras, and what a press of their buttons does.

export type Center = readonly [lon: number, lat: number]

// The ground, low to high, and its shading: CSS token and fallback (src/styles.test.ts holds every
// one at 3:1 under the course's marks, and each fallback to the sheet's value)
export const RELIEF = [
  ['--relief-1', '#0a1d2b'],
  ['--relief-2', '#0e3036'],
  ['--relief-3', '#1f3d32'],
  ['--relief-4', '#38432f'],
  ['--relief-5', '#4a4438'],
] as const
export const SHADING = {
  shade: ['--relief-shade', '#030a1c'],
  light: ['--relief-light', '#2a4852'],
} as const

// A flat course still counts 20 m of relief (a 30 m ramp)
const MIN_SPAN = 20
// The orbit: its centre reaches the course's in 1 s, then a full turn in 90 s
export const GLIDE_MS = 1000
const ORBIT_DEG_PER_MS = 360 / 90_000

// [altitude, color, altitude, color…] for a color-relief: the colors evenly over the course's middle
// altitude ± 3/4 of its span (at least MIN_SPAN), a quarter of the span past each end; one color,
// one stop; no altitudes, around 0 m. A fold, not a spread: a big GPX has too many points for Math.min.
export const reliefStops = (altitudes: ReadonlyArray<number>, colors: ReadonlyArray<string>) => {
  const [low, high] = altitudes.reduce(
    ([min, max], altitude) => [Math.min(min, altitude), Math.max(max, altitude)],
    [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]
  )
  const middle = altitudes.length === 0 ? 0 : (low + high) / 2
  const half = 0.75 * Math.max(altitudes.length === 0 ? 0 : high - low, MIN_SPAN)
  const last = Math.max(1, colors.length - 1)
  return colors.flatMap((color, k) => [middle - half + (2 * half * k) / last, color])
}

const bearing = (from: TrackPoint, to: TrackPoint) => {
  const lat1 = (from[1] * Math.PI) / 180
  const lat2 = (to[1] * Math.PI) / 180
  const dLon = ((to[0] - from[0]) * Math.PI) / 180
  const y = Math.sin(dLon) * Math.cos(lat2)
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon)
  return (Math.atan2(y, x) * 180) / Math.PI
}

// The flight's camera at course point i: there, behind the runner, heading 12 points on (at the
// finish, along the last step); null past the end or on a course of one point
export const followCamera = (track: ReadonlyArray<TrackPoint>, i: number) => {
  const j = Math.min(i, track.length - 2)
  const here = track[i]
  const from = track[j]
  const ahead = track[Math.min(track.length - 1, j + 12)]
  if (here === undefined || from === undefined || ahead === undefined) return null
  return {
    center: [here[0], here[1]] as [number, number],
    bearing: bearing(from, ahead),
    pitch: 72,
    zoom: 14.2,
  }
}

// The orbit's camera `elapsed` ms in: the centre gliding from `from` to `to`, the bearing turning
export const orbitCamera = (from: Center, to: Center, start: number, elapsed: number) => {
  const t = Math.min(1, Math.max(0, elapsed / GLIDE_MS))
  return {
    center: [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t] as [number, number],
    bearing: start + elapsed * ORBIT_DEG_PER_MS,
  }
}

export type Motion = 'still' | 'flight' | 'orbit'
export type Mode = Exclude<Motion, 'still'>

// A press of a mode's button. It stops a running motion: always its own, and any under reduced
// motion. From still: one step under reduced motion, else that mode.
export const pressed = (motion: Motion, mode: Mode, reduced: boolean): Motion | 'step' =>
  motion === mode || (reduced && motion !== 'still') ? 'still' : reduced ? 'step' : mode

export const middle = (bounds: Bounds): Center => [
  (bounds[0] + bounds[2]) / 2,
  (bounds[1] + bounds[3]) / 2,
]
