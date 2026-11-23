import { Result, Schema } from 'effect'

import { parsePace } from '../garmin/workout-builder.ts'
import { round } from '../numbers.ts'

import { type Course, type Segment, segmentCourse, totals } from './course.ts'
import { type Fuel, fuelling, type Run, timeAt, timeline } from './pacing.ts'

// A race's files and what get_race says of them, without I/O. In data/races/: <slug>.gpx (the
// course, the source of truth), <slug>.json (its facts), <slug>.plan.json (the plan the MCP writes).

// Its own day pattern, as journal/note.ts: this module must not load the API's
const Day = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/u))
const Text = (max: number) => Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(max))
const Km = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(1000))
const Between = (min: number, max: number) =>
  Schema.Finite.check(Schema.isGreaterThanOrEqualTo(min), Schema.isLessThanOrEqualTo(max))

export const HHMMSchema = Schema.String.check(
  Schema.isPattern(/^(?:[01]\d|2[0-3]):[0-5]\d$/u)
).pipe(Schema.brand('HHMM'))
export type HHMM = typeof HHMMSchema.Type

export const SlugSchema = Schema.String.check(
  Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
  Schema.isMaxLength(64)
).pipe(Schema.brand('Slug'))
export type Slug = typeof SlugSchema.Type

// "Marathon du Mont-Blanc", 2027-06-27 → marathon-du-mont-blanc-2027 (the year once); null when
// no letter or digit is left
export const slugOf = (name: string, date: string): Slug | null => {
  const words = name
    .normalize('NFD')
    .replaceAll(/\p{M}/gu, '')
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, '-')
    .replaceAll(/^-|-$/gu, '')
  if (words === '') return null
  const year = date.slice(0, 4)
  const slug = (words.split('-').includes(year) ? words : `${words}-${year}`)
    .slice(0, 64)
    .replace(/-$/u, '')
  return SlugSchema.make(slug)
}

export const racePaths = (slug: Slug) => ({
  gpx: `races/${slug}.gpx`,
  facts: `races/${slug}.json`,
  plan: `races/${slug}.plan.json`,
})

const AidStation = Schema.Struct({
  km: Km,
  name: Text(120),
  offers: Schema.optionalKey(Text(300).annotate({ description: 'e.g. "eau, coca, salé, soupe"' })),
})

const Cutoff = Schema.Struct({
  km: Km,
  time: HHMMSchema.annotate({ description: 'Clock time on race day, HH:MM' }),
  name: Schema.optionalKey(Text(120)),
})

// What the caller knows of a race (add_race, the upload)
export const FactsInputSchema = Schema.Struct({
  name: Text(120),
  date: Day,
  start_time: Schema.optionalKey(HHMMSchema.annotate({ description: 'Start, HH:MM' })),
  aid_stations: Schema.optionalKey(Schema.Array(AidStation)),
  cutoffs: Schema.optionalKey(Schema.Array(Cutoff)),
}).check(
  Schema.makeFilter(
    (facts) => slugOf(facts.name, facts.date) !== null || 'nom sans lettre ni chiffre'
  )
)
export type FactsInput = typeof FactsInputSchema.Type

// The facts file: the same, plus where its altitudes come from (the server's, kept by an update
// without a GPX)
export const RaceFactsJson = Schema.Struct({
  ...FactsInputSchema.fields,
  elevation: Schema.Union([
    Schema.Struct({ source: Schema.Literal('gpx') }),
    Schema.Struct({ source: Schema.Literal('dem'), attribution: Schema.String }),
  ]),
})
export type RaceFacts = typeof RaceFactsJson.Type

// A plan's slowest pace: a steep climb walked, 60'00 a km
const SLOWEST_PACE_S = 3600

const Hr = Schema.Struct({ low: Between(40, 230), high: Between(40, 230) })

const planFields = {
  carbs_g_per_h: Schema.optionalKey(Between(0, 150)),
  gel_carbs_g: Schema.optionalKey(Between(5, 100)),
  water_ml_per_h: Schema.optionalKey(Between(0, 1500)),
  notes: Schema.optionalKey(Text(4000)),
}
const entryFields = {
  segment: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  hr: Schema.optionalKey(Hr),
  fuel: Schema.optionalKey(Text(500)),
  notes: Schema.optionalKey(Text(1000)),
}

// The plan file: each entry carries its segment's km as they were when it was written
export const RacePlanJson = Schema.Struct({
  ...planFields,
  segments: Schema.Array(
    Schema.Struct({
      ...entryFields,
      from_km: Km,
      to_km: Km,
      pace_s: Schema.optionalKey(Between(120, SLOWEST_PACE_S)),
    })
  ),
})
export type RacePlan = typeof RacePlanJson.Type
export type PlanEntry = RacePlan['segments'][number]

// plan_race's input: entries by segment number, a pace as 365 or "6'05/km"
export const PlanInputSchema = Schema.Struct({
  ...planFields,
  segments: Schema.Array(
    Schema.Struct({
      ...entryFields,
      pace: Schema.optionalKey(
        Schema.Union([Schema.Finite, Schema.String]).annotate({
          description: `Seconds per km (365) or "6'05/km", 2'00 to 60'00 (a steep climb walked)`,
        })
      ),
    })
  ),
})
export type PlanInput = typeof PlanInputSchema.Type

export class RaceError extends Schema.TaggedError<RaceError>()('RaceError', {
  reason: Schema.Literals(['exists', 'missing', 'gpx', 'file', 'plan']),
  message: Schema.String,
}) {}

// The plan file from plan_race's input: each entry stamped with its segment's km
export const planFile = (
  input: PlanInput,
  segments: ReadonlyArray<Segment>
): Result.Result<RacePlan, string> => {
  const seen = new Set<number>()
  const entries: Array<PlanEntry> = []
  for (const { pace, ...entry } of input.segments) {
    const segment = segments[entry.segment - 1]
    if (segment === undefined) {
      return Result.fail(`segment ${entry.segment} : le parcours en a ${segments.length}`)
    }
    if (seen.has(entry.segment)) return Result.fail(`segment ${entry.segment} donné deux fois`)
    seen.add(entry.segment)
    const paceS = pace === undefined ? undefined : parsePace(pace, SLOWEST_PACE_S)
    if (pace !== undefined && paceS === undefined) {
      return Result.fail(`segment ${entry.segment} : allure ${JSON.stringify(pace)} illisible`)
    }
    entries.push({
      ...entry,
      from_km: round(segment.from_km, 3) ?? 0,
      to_km: round(segment.to_km, 3) ?? 0,
      ...(paceS === undefined ? {} : { pace_s: paceS }),
    })
  }
  const { segments: _input, ...plan } = input
  return Result.succeed({ ...plan, segments: entries })
}

// The plan's fuel numbers, or these
export const DEFAULT_FUEL: Fuel = { carbs_g_per_h: 60, gel_carbs_g: 25, water_ml_per_h: 500 }

const minutesOf = (time: HHMM) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5))

// The clock time `seconds` after `start`, "+1 j" past midnight
export const clockOf = (start: HHMM, seconds: number) => {
  const minutes = minutesOf(start) + Math.round(seconds / 60)
  const days = Math.floor(minutes / 1440)
  const hh = String(Math.floor((minutes % 1440) / 60)).padStart(2, '0')
  const mm = String(minutes % 60).padStart(2, '0')
  return `${hh}:${mm}${days > 0 ? ` +${days} j` : ''}`
}

// Seconds from the start to a cutoff: one earlier than the start is the next day.
// shortcut: a cutoff is within 24 h of the start (HHMM has no day); add a day offset to cutoffs
// for a race over 24 h.
const secondsUntil = (start: HHMM, cutoff: HHMM) =>
  ((((minutesOf(cutoff) - minutesOf(start)) % 1440) + 1440) % 1440) * 60

export interface RaceSummary {
  readonly slug: Slug
  readonly name: string
  readonly date: string
  readonly km: number
  readonly d_plus: number
  readonly d_minus: number
  readonly km_effort: number
  readonly planned: boolean
  // The predicted finish, without a run to predict from null
  readonly predicted_s: number | null
}

export type Passing =
  | {
      readonly kind: 'aid'
      readonly km: number
      readonly name: string
      readonly offers: string | null
      readonly at_s: number
      readonly clock: string | null
    }
  | {
      readonly kind: 'cutoff'
      readonly km: number
      readonly name: string | null
      readonly at_s: number
      readonly cutoff: HHMM
      // With a start time only
      readonly timing: { readonly clock: string; readonly margin_s: number } | null
    }

export interface SegmentView extends Omit<Segment, 'from' | 'to'> {
  readonly plan: PlanEntry | null
}

export interface RaceView extends Omit<RaceSummary, 'predicted_s'> {
  readonly facts: RaceFacts
  readonly ele_min: number
  readonly ele_max: number
  readonly segments: ReadonlyArray<SegmentView>
  readonly fuel: Fuel
  readonly notes: string | null
  readonly warnings: ReadonlyArray<string>
  // Without a run of 3 km or more in the last year, null: the segments and the plan stand alone
  readonly prediction: {
    readonly total_s: number
    readonly reference: Run
    readonly segments: ReadonlyArray<{
      readonly index: number
      readonly time_s: number
      readonly start_s: number
      readonly end_s: number
      readonly clock: { readonly start: string; readonly end: string } | null
      readonly gels: number
      readonly water_ml: number
    }>
    readonly passings: ReadonlyArray<Passing>
    readonly gels: ReadonlyArray<{ readonly at_s: number; readonly km: number }>
  } | null
}

// The plan's entries that still match their segment, and a warning for each one that does not
const matchPlan = (plan: RacePlan | null, segments: ReadonlyArray<Segment>) => {
  const matched = new Map<number, PlanEntry>()
  const warnings: Array<string> = []
  for (const entry of plan?.segments ?? []) {
    const segment = segments[entry.segment - 1]
    if (
      segment !== undefined &&
      Math.abs(segment.from_km - entry.from_km) < 0.01 &&
      Math.abs(segment.to_km - entry.to_km) < 0.01
    ) {
      matched.set(entry.segment, entry)
    } else {
      warnings.push(
        `Plan du segment ${entry.segment} (km ${entry.from_km}–${entry.to_km}) : le parcours a changé, non appliqué.`
      )
    }
  }
  return { matched, warnings }
}

// Everything get_race says: facts, totals, segments with their plan and predicted times, the
// passing times at aid stations and cutoffs, the gels and water, warnings
export const raceView = ({
  slug,
  facts,
  plan,
  course,
  reference,
}: {
  readonly slug: Slug
  readonly facts: RaceFacts
  readonly plan: RacePlan | null
  readonly course: Course
  readonly reference: Run | null
}): RaceView => {
  const all = totals(course)
  const segments = segmentCourse(course)
  const { matched, warnings } = matchPlan(plan, segments)
  const fuel: Fuel = { ...DEFAULT_FUEL, ...pick(plan) }
  const outside = [...(facts.aid_stations ?? []), ...(facts.cutoffs ?? [])].filter(
    (point) => point.km > all.km + 0.05
  )
  for (const point of outside) {
    warnings.push(`Le point au km ${point.km} est après l'arrivée (${round(all.km, 2)} km).`)
  }
  return {
    slug,
    name: facts.name,
    date: facts.date,
    km: round(all.km, 2) ?? 0,
    d_plus: Math.round(all.d_plus),
    d_minus: Math.round(all.d_minus),
    km_effort: round(all.km_effort, 1) ?? 0,
    ele_min: Math.round(all.ele_min),
    ele_max: Math.round(all.ele_max),
    planned: plan !== null,
    facts,
    segments: segments.map(({ from: _from, to: _to, ...segment }) => ({
      ...segment,
      from_km: round(segment.from_km, 2) ?? 0,
      to_km: round(segment.to_km, 2) ?? 0,
      km: round(segment.km, 2) ?? 0,
      d_plus: Math.round(segment.d_plus),
      d_minus: Math.round(segment.d_minus),
      grade_pct: round(segment.grade_pct, 1) ?? 0,
      km_effort: round(segment.km_effort, 1) ?? 0,
      equivalent_km: round(segment.equivalent_km, 2) ?? 0,
      plan: matched.get(segment.index) ?? null,
    })),
    fuel,
    notes: plan?.notes ?? null,
    warnings,
    prediction:
      reference === null ? null : predict(course, segments, reference, matched, facts, fuel),
  }
}

const pick = (plan: RacePlan | null): Partial<Fuel> => ({
  ...(plan?.carbs_g_per_h === undefined ? {} : { carbs_g_per_h: plan.carbs_g_per_h }),
  ...(plan?.gel_carbs_g === undefined ? {} : { gel_carbs_g: plan.gel_carbs_g }),
  ...(plan?.water_ml_per_h === undefined ? {} : { water_ml_per_h: plan.water_ml_per_h }),
})

// The times: per segment, at the aid stations and cutoffs, and the gels
const predict = (
  course: Course,
  segments: ReadonlyArray<Segment>,
  reference: Run,
  plan: ReadonlyMap<number, PlanEntry>,
  facts: RaceFacts,
  fuel: Fuel
): NonNullable<RaceView['prediction']> => {
  const paces = new Map(
    [...plan].flatMap(([index, entry]) =>
      entry.pace_s === undefined ? [] : [[index, entry.pace_s] as const]
    )
  )
  const times = timeline(course, segments, reference, paces)
  const start = facts.start_time
  const clock = (seconds: number) => (start === undefined ? null : clockOf(start, seconds))
  const { gels, per_segment } = fuelling(times, segments, fuel)
  const at = (km: number) => Math.round(timeAt(times, km * 1000))
  const passings: Array<Passing> = [
    ...(facts.aid_stations ?? []).map((aid) => ({
      kind: 'aid' as const,
      km: aid.km,
      name: aid.name,
      offers: aid.offers ?? null,
      at_s: at(aid.km),
      clock: clock(at(aid.km)),
    })),
    ...(facts.cutoffs ?? []).map((cutoff) => ({
      kind: 'cutoff' as const,
      km: cutoff.km,
      name: cutoff.name ?? null,
      at_s: at(cutoff.km),
      cutoff: cutoff.time,
      timing:
        start === undefined
          ? null
          : {
              clock: clockOf(start, at(cutoff.km)),
              margin_s: secondsUntil(start, cutoff.time) - at(cutoff.km),
            },
    })),
  ].toSorted((a, b) => a.km - b.km)
  return {
    total_s: Math.round(times.at(-1)?.t ?? 0),
    reference,
    segments: segments.map((segment, i) => {
      const startS = at(segment.from_km)
      const endS = at(segment.to_km)
      const fuelled = per_segment[i]
      return {
        index: segment.index,
        time_s: endS - startS,
        start_s: startS,
        end_s: endS,
        clock:
          start === undefined ? null : { start: clockOf(start, startS), end: clockOf(start, endS) },
        gels: fuelled?.gels ?? 0,
        water_ml: Math.round(fuelled?.water_ml ?? 0),
      }
    }),
    passings,
    gels: gels.map((gel) => ({ at_s: Math.round(gel.at_s), km: round(gel.km, 2) ?? 0 })),
  }
}
