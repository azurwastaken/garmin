import { Brand } from 'effect'

import { cumulativeEquivalent, interpolate, type Profile, type Segment } from './course.ts'

// The race's times, without I/O: the user's best run carried to the race's flat-equivalent
// distance (Riegel), split over the course by effort; a planned pace replaces its segment's time.

const RIEGEL = 1.06

export const riegel = (seconds: number, fromM: number, toM: number) =>
  seconds * (toM / fromM) ** RIEGEL

export interface Effort {
  readonly moving_s: number
  readonly equivalent_m: number
}

export interface Run extends Effort {
  readonly id: number
  readonly day: string
  readonly name: string | null
  readonly distance_m: number
}

// The run that predicts best: the least time once carried to a common distance
export const bestEffort = <R extends Effort>(runs: ReadonlyArray<R>): R | null =>
  runs.reduce<R | null>(
    (best, run) =>
      best === null ||
      run.moving_s / run.equivalent_m ** RIEGEL < best.moving_s / best.equivalent_m ** RIEGEL
        ? run
        : best,
    null
  )

// The distance (m) and the time (s) from the start at each profile point: t from 0, never
// decreasing, so either reads the other by interpolation
export type Timeline = {
  readonly d: ReadonlyArray<number>
  readonly t: ReadonlyArray<number>
} & Brand.Brand<'Timeline'>
const makeTimeline = Brand.nominal<Timeline>()

// Seconds from the start at every point: the model's total (riegel from the reference to the
// race's equivalent distance) split by equivalent distance; a planned pace (s/km, > 0) gives its
// segment's time, spread by distance within it
export const timeline = (
  profile: Profile,
  segments: ReadonlyArray<Segment>,
  reference: Effort,
  paces: ReadonlyMap<number, number>
): Timeline => {
  const distance = profile.map((point) => point.d)
  const equivalent = cumulativeEquivalent(profile)
  const sum = equivalent.at(-1) ?? 0
  const total = riegel(reference.moving_s, reference.equivalent_m, sum)
  const times = profile.map(() => 0)
  let start = 0
  for (const segment of segments) {
    const pace = paces.get(segment.index)
    // The segment's own measure from its first point: equivalent metres, or metres when paced
    const measure = pace === undefined ? equivalent : distance
    const from = measure[segment.from] ?? 0
    const span = (measure[segment.to] ?? 0) - from
    const time = pace === undefined ? (total * span) / sum : pace * segment.km
    for (let i = segment.from; i <= segment.to; i += 1) {
      times[i] = start + (span === 0 ? 0 : (time * ((measure[i] ?? 0) - from)) / span)
    }
    start += time
  }
  return makeTimeline({ d: distance, t: times })
}

// The time at a distance from the start (m), and the distance at a time (s)
export const timeAt = (timeline: Timeline, m: number) => interpolate(timeline.d, timeline.t, m)
export const distanceAt = (timeline: Timeline, s: number) => interpolate(timeline.t, timeline.d, s)

export interface Fuel {
  readonly carbs_g_per_h: number
  readonly gel_carbs_g: number
  readonly water_ml_per_h: number
}

// Seconds between two gels: gel_carbs_g / carbs_g_per_h hours; none without carbs
export const gelEvery = (fuel: Fuel) =>
  fuel.carbs_g_per_h > 0 ? (fuel.gel_carbs_g / fuel.carbs_g_per_h) * 3600 : null

// A gel every gelEvery from the start, where it falls on the course; and per segment, its gels
// and its water
export const fuelling = (timeline: Timeline, segments: ReadonlyArray<Segment>, fuel: Fuel) => {
  const total = timeline.t.at(-1) ?? 0
  const every = gelEvery(fuel)
  const count = every === null ? 0 : Math.ceil(total / every) - 1
  const gels = Array.from({ length: Math.max(0, count) }, (_, k) => {
    const at = (k + 1) * (every ?? 0)
    return { at_s: at, km: distanceAt(timeline, at) / 1000 }
  })
  const perSegment = segments.map((segment) => {
    const start = timeAt(timeline, segment.from_km * 1000)
    const end = timeAt(timeline, segment.to_km * 1000)
    return {
      gels: gels.filter((gel) => gel.at_s >= start && gel.at_s < end).length,
      water_ml: (fuel.water_ml_per_h * (end - start)) / 3600,
    }
  })
  return { gels, per_segment: perSegment }
}
