import type { Brand } from 'effect'

import type { Fix, LatLon } from './gpx.ts'

// A course's profile and its segments, without I/O: the race's GPX and the user's runs alike go
// through profileOf, so both are measured the same way.

export const STEP_M = 25
// ±50 m: smooths a barometer's or a DEM's jitter, keeps any climb of 100 m or more
const SMOOTH_HALF_STEPS = 2

export interface ProfilePoint {
  readonly d: number
  readonly ele: number
}
export interface CoursePoint extends ProfilePoint, LatLon {}

// A point every STEP_M from 0 (the last at the total distance), altitudes gap-filled and smoothed
export type Profile<P extends ProfilePoint = ProfilePoint> = ReadonlyArray<P> &
  Brand.Brand<'Profile'>
export type Course = Profile<CoursePoint>

// The profile's distance and altitude at a point (the dense arrays' index is always in range)
const dAt = (profile: ReadonlyArray<ProfilePoint>, i: number) => profile[i]?.d ?? 0
const eleAt = (profile: ReadonlyArray<ProfilePoint>, i: number) => profile[i]?.ele ?? 0

const EARTH_RADIUS_M = 6_371_008.8
const radians = (degrees: number) => (degrees * Math.PI) / 180

export const haversine = (a: LatLon, b: LatLon) => {
  const dLat = radians(b.lat - a.lat)
  const dLon = radians(b.lon - a.lon)
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(radians(a.lat)) * Math.cos(radians(b.lat)) * Math.sin(dLon / 2) ** 2
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)))
}

// The distance from the first point at each point
export const cumulative = (points: ReadonlyArray<LatLon>) => {
  let total = 0
  return points.map((point, i) => {
    const previous = points[i - 1]
    if (previous !== undefined) total += haversine(previous, point)
    return total
  })
}

// Linear interpolation of y at x over increasing xs (clamped at the ends)
const interpolate = (xs: ReadonlyArray<number>, ys: ReadonlyArray<number>, x: number) => {
  let lo = 0
  let hi = xs.length - 1
  if (x <= (xs[0] ?? 0)) return ys[0] ?? 0
  if (x >= (xs[hi] ?? 0)) return ys[hi] ?? 0
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if ((xs[mid] ?? 0) <= x) lo = mid
    else hi = mid
  }
  const x0 = xs[lo] ?? 0
  const x1 = xs[hi] ?? 0
  const y0 = ys[lo] ?? 0
  const y1 = ys[hi] ?? 0
  return x1 === x0 ? y0 : y0 + ((y1 - y0) * (x - x0)) / (x1 - x0)
}

// The missing values interpolated along d (the nearest one at the ends); null when none is known
export const fillGaps = (d: ReadonlyArray<number>, values: ReadonlyArray<number | null>) => {
  const known = values.flatMap((value, i) => (value === null ? [] : [i]))
  if (known.length === 0) return null
  const xs = known.map((i) => d[i] ?? 0)
  const ys = known.map((i) => values[i] ?? 0)
  return values.map((value, i) => value ?? interpolate(xs, ys, d[i] ?? 0))
}

// The positions every `step` from 0, the total last
const positions = (total: number, step: number) => {
  const at = Array.from({ length: Math.floor(total / step) + 1 }, (_, k) => k * step)
  if (total - (at.at(-1) ?? 0) > 1e-6) at.push(total)
  return at
}

// The values at every `step` along d, which must be strictly increasing
export const resampleAt = (d: ReadonlyArray<number>, values: ReadonlyArray<number>, step: number) =>
  positions(d.at(-1) ?? 0, step).map((x) => interpolate(d, values, x))

// A centred moving average over ±halfSteps points (narrower at the ends)
export const smooth = (values: ReadonlyArray<number>, halfSteps: number) =>
  values.map((_, i) => {
    const window = values.slice(Math.max(0, i - halfSteps), i + halfSteps + 1)
    return window.reduce((sum, value) => sum + value, 0) / window.length
  })

// The metres climbed and descended between two points of a profile (the whole by default)
export const climb = (profile: Profile, from = 0, to = profile.length - 1) => {
  let up = 0
  let down = 0
  for (let i = from; i < to; i += 1) {
    const rise = eleAt(profile, i + 1) - eleAt(profile, i)
    if (rise > 0) up += rise
    else down -= rise
  }
  return { up, down }
}

// The indices of the points that move forward: a repeated point or a watch standing still is one
const advancing = (d: ReadonlyArray<number>) => {
  const kept: Array<number> = []
  for (const [i, value] of d.entries()) {
    if (kept.length === 0 || value > (d[kept.at(-1) ?? 0] ?? 0)) kept.push(i)
  }
  return kept
}

// Distances and altitudes (null where missing) → the profile; null with fewer than 2 distinct
// points or no altitude at all
export const profileOf = (
  d: ReadonlyArray<number>,
  ele: ReadonlyArray<number | null>
): Profile | null => {
  const kept = advancing(d)
  const keptD = kept.map((i) => d[i] ?? 0)
  const filled = fillGaps(
    keptD,
    kept.map((i) => ele[i] ?? null)
  )
  if (kept.length < 2 || filled === null) return null
  const at = positions(keptD.at(-1) ?? 0, STEP_M)
  const smoothed = smooth(resampleAt(keptD, filled, STEP_M), SMOOTH_HALF_STEPS)
  return at.map((x, i) => ({ d: x, ele: smoothed[i] ?? 0 })) as unknown as Profile
}

// The race's fixes → its course: the profile, with lat/lon at the same steps
export const courseOf = (fixes: ReadonlyArray<Fix>): Course | null => {
  const d = cumulative(fixes)
  const profile = profileOf(
    d,
    fixes.map((fix) => fix.ele)
  )
  if (profile === null) return null
  const kept = advancing(d)
  const keptD = kept.map((i) => d[i] ?? 0)
  const lat = resampleAt(
    keptD,
    kept.map((i) => fixes[i]?.lat ?? 0),
    STEP_M
  )
  const lon = resampleAt(
    keptD,
    kept.map((i) => fixes[i]?.lon ?? 0),
    STEP_M
  )
  return profile.map((point, i) => ({
    ...point,
    lat: lat[i] ?? 0,
    lon: lon[i] ?? 0,
  })) as unknown as Course
}

// --- Segments

export type SegmentKind = 'climb' | 'descent' | 'flat'

export interface Segment {
  // 1-based: the plan's key
  readonly index: number
  readonly kind: SegmentKind
  // Indices into the profile
  readonly from: number
  readonly to: number
  readonly from_km: number
  readonly to_km: number
  readonly km: number
  readonly d_plus: number
  readonly d_minus: number
  // Net, in %
  readonly grade_pct: number
  // km + D+/100 (ITRA)
  readonly km_effort: number
  // The flat distance of the same effort (gapFactor)
  readonly equivalent_km: number
}

const CLIMB_PCT = 3
const TINY_KM = 0.4
const TINY_RISE_M = 15
const LONGEST_KM = 5

interface Run {
  readonly kind: SegmentKind
  readonly from: number
  readonly to: number
}

const kindOf = (gradePct: number): SegmentKind =>
  gradePct >= CLIMB_PCT ? 'climb' : gradePct <= -CLIMB_PCT ? 'descent' : 'flat'

const netGrade = (profile: Profile, from: number, to: number) => {
  const run = dAt(profile, to) - dAt(profile, from)
  return run === 0 ? 0 : (100 * (eleAt(profile, to) - eleAt(profile, from))) / run
}

const kmOf = (profile: Profile, run: Run) => (dAt(profile, run.to) - dAt(profile, run.from)) / 1000

// A run too small to plan on its own: short, or a climb or descent of little vertical (a flat
// never is for want of vertical)
const tiny = (profile: Profile, run: Run) =>
  kmOf(profile, run) < TINY_KM ||
  (run.kind !== 'flat' && Math.abs(eleAt(profile, run.to) - eleAt(profile, run.from)) < TINY_RISE_M)

// Each step's class, as runs of one class
const stepRuns = (profile: Profile): Array<Run> => {
  const runs: Array<Run> = []
  for (let i = 0; i < profile.length - 1; i += 1) {
    const kind = kindOf(netGrade(profile, i, i + 1))
    const last = runs.at(-1)
    if (last?.kind === kind) runs[runs.length - 1] = { ...last, to: i + 1 }
    else runs.push({ kind, from: i, to: i + 1 })
  }
  return runs
}

// Neighbours of the same class as one run
const coalesce = (runs: ReadonlyArray<Run>) =>
  runs.reduce<Array<Run>>((out, run) => {
    const last = out.at(-1)
    if (last?.kind === run.kind) out[out.length - 1] = { ...last, to: run.to }
    else out.push(run)
    return out
  }, [])

// The tiniest run merged into the neighbour of the closer grade, again while one is tiny
const mergeTiny = (profile: Profile, start: ReadonlyArray<Run>) => {
  let runs = coalesce(start)
  for (;;) {
    const tiniest = runs
      .map((run, i) => ({ run, i, km: kmOf(profile, run) }))
      .filter(({ run }) => tiny(profile, run))
      .reduce<{ run: Run; i: number; km: number } | null>(
        (best, next) => (best === null || next.km < best.km ? next : best),
        null
      )
    if (runs.length < 2 || tiniest === null) return runs
    runs = coalesce(mergeAt(profile, runs, tiniest.i, tiniest.run))
  }
}

// The run at i joined to the neighbour whose grade is closer to its own
const mergeAt = (profile: Profile, runs: ReadonlyArray<Run>, i: number, run: Run) => {
  const grade = netGrade(profile, run.from, run.to)
  const distance = (other: Run | undefined) =>
    other === undefined
      ? Number.POSITIVE_INFINITY
      : Math.abs(netGrade(profile, other.from, other.to) - grade)
  const at = distance(runs[i - 1]) <= distance(runs[i + 1]) ? i - 1 : i
  const from = runs[at]?.from ?? run.from
  const to = runs[at + 1]?.to ?? run.to
  const merged = { kind: kindOf(netGrade(profile, from, to)), from, to }
  return [...runs.slice(0, at), merged, ...runs.slice(at + 2)]
}

// Runs over LONGEST_KM cut into equal parts: a flat road marathon still has parts to plan
const splitLong = (profile: Profile, runs: ReadonlyArray<Run>) =>
  runs.flatMap((run) => {
    const parts = Math.ceil(kmOf(profile, run) / LONGEST_KM)
    if (parts <= 1) return [run]
    const steps = run.to - run.from
    return Array.from({ length: parts }, (_, k) => ({
      kind: run.kind,
      from: run.from + Math.round((k * steps) / parts),
      to: run.from + Math.round(((k + 1) * steps) / parts),
    }))
  })

const segmentOf = (profile: Profile, run: Run, index: number): Segment => {
  const fromKm = dAt(profile, run.from) / 1000
  const toKm = dAt(profile, run.to) / 1000
  const { up, down } = climb(profile, run.from, run.to)
  return {
    index,
    kind: run.kind,
    from: run.from,
    to: run.to,
    from_km: fromKm,
    to_km: toKm,
    km: toKm - fromKm,
    d_plus: up,
    d_minus: down,
    grade_pct: netGrade(profile, run.from, run.to),
    km_effort: toKm - fromKm + up / 100,
    equivalent_km: equivalentM(profile, run.from, run.to) / 1000,
  }
}

// The course cut into climbs, descents and flats: consecutive, from the start to the finish
export const segmentCourse = (profile: Profile): ReadonlyArray<Segment> =>
  splitLong(profile, mergeTiny(profile, stepRuns(profile))).map((run, i) =>
    segmentOf(profile, run, i + 1)
  )

// --- Grade-adjusted effort

// Strava's 2017 data-driven grade-adjusted pace, as a reverse-engineered quartic in % grade,
// divided by its value at 0 so that flat is exactly 1: about 0.876 at −8 %, 1.037 at −18 %,
// 1.45 at +10 %. Clamped to ±35 % (past that the fit has no data, and a runner walks).
const GAP = [0.98462, 0.030266, 0.0018814, -3.3882e-6, -4.5704e-7] as const
const gapPolynomial = (g: number) => GAP.reduce((sum, c, power) => sum + c * g ** power, 0)
export const gapFactor = (gradePct: number) =>
  gapPolynomial(Math.max(-35, Math.min(35, gradePct))) / GAP[0]

// The flat distance of the same effort between two points of a profile (the whole by default)
export const equivalentM = (profile: Profile, from = 0, to = profile.length - 1) => {
  let sum = 0
  for (let i = from; i < to; i += 1) {
    sum += (dAt(profile, i + 1) - dAt(profile, i)) * gapFactor(netGrade(profile, i, i + 1))
  }
  return sum
}

export const totals = (course: Course) => {
  const { up, down } = climb(course)
  const km = dAt(course, course.length - 1) / 1000
  const ele = course.map((point) => point.ele)
  return {
    km,
    d_plus: up,
    d_minus: down,
    km_effort: km + up / 100,
    ele_min: Math.min(...ele),
    ele_max: Math.max(...ele),
    // West, south, east, north
    bbox: [
      Math.min(...course.map((p) => p.lon)),
      Math.min(...course.map((p) => p.lat)),
      Math.max(...course.map((p) => p.lon)),
      Math.max(...course.map((p) => p.lat)),
    ] as const,
  }
}
