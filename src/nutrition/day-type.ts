import { parseDuration } from '../garmin/workout-builder.ts'

import type { DayType } from './plan.ts'

// A day's type for the plan's kcal, without I/O: from what was done that day, else from what its
// calendar plans. Long is a running day (75 min or 15 km of running); quality any sport's (20 min in
// zones 4–5 once done; before, the plan's words, its HR targets, its repetitions); any other session
// makes an easy day; nothing, a rest day.

export interface PlannedSession {
  readonly name: string
  readonly description: string | null
  readonly sport: string | null
  // describeStep's lines (connect.ts)
  readonly steps: string | null
  readonly minutes: number | null
  readonly km: number | null
}

export interface DoneSession {
  readonly sport: string
  readonly minutes: number
  readonly km: number | null
  // Minutes in the watch's HR zones 4 and 5
  readonly z45_minutes: number
}

export interface Classified {
  readonly type: DayType
  readonly from: 'done' | 'planned' | 'nothing'
  // Why, in French, for the page and the coach
  readonly reason: string
}

// A step of describeStep (connect.ts), read back: `${kind}${ exercise} ${end}${target}${ (note)}`
export interface Step {
  // interval, warmup, recovery, rest, cooldown…
  readonly kind: string
  readonly seconds: number | null
  readonly metres: number | null
  // "HR zone ?" (no zone number) is no target
  readonly target:
    | { readonly kind: 'hr'; readonly low: number; readonly high: number }
    | { readonly kind: 'hr-zone'; readonly zone: number }
    | { readonly kind: 'pace' }
    | null
  // Inside an `N× [...]` group
  readonly repeated: boolean
}

const GROUP = /^(?:\d+|\?)× \[(.*)\]$/su
const STEP =
  /^(\w+)(?: [A-Z0-9_]+)? (lap button|\d+(?::\d{2}){1,2}|\d+(?:\.\d+)? k?m|\d+ reps)(?: HR (\d+)-(\d+)| HR zone ([\d?])| (pace) \S+)?(?: \(.*\))?$/su

// A group's inside, split on its ", " outside parentheses and brackets (notes hold commas)
const splitTop = (text: string): Array<string> => {
  const pieces: Array<string> = []
  let depth = 0
  let start = 0
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (character === '(' || character === '[') depth += 1
    else if (character === ')' || character === ']') depth -= 1
    else if (depth === 0 && text.startsWith(', ', index)) {
      pieces.push(text.slice(start, index))
      start = index + 2
    }
  }
  pieces.push(text.slice(start))
  return pieces
}

// A step's end as a length: "3:00" and "1:05:00" in seconds, "400 m" and "1.5 km" in metres
const lengthOf = (end: string): Pick<Step, 'seconds' | 'metres'> => {
  const distance = /^(\d+(?:\.\d+)?) (k?)m$/u.exec(end)
  if (distance !== null) {
    return { seconds: null, metres: Number(distance[1]) * (distance[2] === 'k' ? 1000 : 1) }
  }
  return { seconds: end.includes(':') ? (parseDuration(end) ?? null) : null, metres: null }
}

const targetOf = (
  low: string | undefined,
  high: string | undefined,
  zone: string | undefined,
  pace: string | undefined
): Step['target'] => {
  if (low !== undefined && high !== undefined) {
    return { kind: 'hr', low: Number(low), high: Number(high) }
  }
  if (zone !== undefined && zone !== '?') return { kind: 'hr-zone', zone: Number(zone) }
  return pace === undefined ? null : { kind: 'pace' }
}

// One line or one piece of a group: its steps, a group's flattened; none when it cannot be read
const readPiece = (piece: string, repeated: boolean): Array<Step> => {
  const group = GROUP.exec(piece)
  if (group !== null) return splitTop(group[1] ?? '').flatMap((inner) => readPiece(inner, true))
  const step = STEP.exec(piece)
  if (step === null) return []
  const [, kind = '', end = '', low, high, zone, pace] = step
  return [{ kind, ...lengthOf(end), target: targetOf(low, high, zone, pace), repeated }]
}

// Every step of a workout's steps text, a repeat group's (nested ones too) flattened; a line it
// cannot read is left out. It reads connect.ts describeStep's lines: change both together
export const readSteps = (steps: string): Array<Step> =>
  steps.split('\n').flatMap((line) => readPiece(line.trim(), false))

// The classifier's rules (the plan's thresholds are the weight trend's)
const LONG_MINUTES = 75
const LONG_KM = 15
const QUALITY_Z45_MINUTES = 20
// A repetition worth the name: a stride (0:20) is not one
const REP_SECONDS = 60
const REP_METRES = 200
const QUALITY_WORDS = /tempo|seuil|threshold|fractionn|vma|intervalles|fartlek|côtes/iu

const isRun = (sport: string | null) => sport !== null && /running/u.test(sport)
const isStrength = (sport: string | null) => sport === 'strength_training'

// The day's runs together, when they make a long day: why, else null
const longRuns = (
  sessions: ReadonlyArray<{
    readonly sport: string | null
    readonly minutes: number | null
    readonly km: number | null
  }>
): string | null => {
  const runs = sessions.filter((session) => isRun(session.sport))
  const minutes = runs.reduce((sum, run) => sum + (run.minutes ?? 0), 0)
  const km = runs.reduce((sum, run) => sum + (run.km ?? 0), 0)
  return minutes >= LONG_MINUTES || km >= LONG_KM
    ? `${Math.round(minutes)} min et ${km.toLocaleString('fr-FR', { maximumFractionDigits: 1 })} km de course`
    : null
}

// A step that makes the session a quality one: why, else null. A repeated HR target is judged by
// the zone-4 floor alone, like any HR target
const stepMarker = (step: Step, z4FloorBpm: number | null): string | null => {
  const { target } = step
  if (target?.kind === 'hr') {
    return z4FloorBpm !== null && target.high > z4FloorBpm
      ? `cible FC ${target.low}-${target.high} au-dessus de ${z4FloorBpm} (zone 4)`
      : null
  }
  if (target?.kind === 'hr-zone') return target.zone >= 4 ? `cible FC en zone ${target.zone}` : null
  if (!step.repeated || step.kind !== 'interval') return null
  if (target?.kind === 'pace') return 'répétitions à une allure cible'
  return (step.seconds ?? 0) >= REP_SECONDS || (step.metres ?? 0) >= REP_METRES
    ? 'répétitions'
    : null
}

// A planned session's quality marker, else null: a quality word in its name or description (never in
// its steps, where `interval` is every main step's kind), then its steps (never a strength
// session's: its exercises are `interval` steps of a minute)
const qualityMarker = (session: PlannedSession, z4FloorBpm: number | null): string | null => {
  const word = QUALITY_WORDS.exec(`${session.name} ${session.description ?? ''}`)
  if (word !== null) return `« ${word[0]} » dans la séance`
  if (isStrength(session.sport)) return null
  return (
    readSteps(session.steps ?? '')
      .map((step) => stepMarker(step, z4FloorBpm))
      .find((marker) => marker !== null) ?? null
  )
}

const doneType = (done: ReadonlyArray<DoneSession>): Classified => {
  const long = longRuns(done)
  if (long !== null) return { type: 'long', from: 'done', reason: long }
  const hard = done.find((session) => session.z45_minutes >= QUALITY_Z45_MINUTES)
  if (hard !== undefined) {
    return {
      type: 'quality',
      from: 'done',
      reason: `${Math.round(hard.z45_minutes)} min en zones 4–5`,
    }
  }
  return { type: 'easy', from: 'done', reason: 'séance sans intensité' }
}

const plannedType = (
  planned: ReadonlyArray<PlannedSession>,
  z4FloorBpm: number | null
): Classified => {
  const long = longRuns(planned)
  if (long !== null) return { type: 'long', from: 'planned', reason: `${long} prévus` }
  const marker = planned
    .map((session) => qualityMarker(session, z4FloorBpm))
    .find((found) => found !== null)
  if (marker !== undefined) return { type: 'quality', from: 'planned', reason: marker }
  return { type: 'easy', from: 'planned', reason: 'séance prévue sans intensité' }
}

// The day's type from what was done, else from what is planned: done sessions replace the plan.
// long > quality > easy > rest
export const dayType = (
  done: ReadonlyArray<DoneSession>,
  planned: ReadonlyArray<PlannedSession>,
  z4FloorBpm: number | null
): Classified => {
  if (done.length > 0) return doneType(done)
  if (planned.length > 0) return plannedType(planned, z4FloorBpm)
  return { type: 'rest', from: 'nothing', reason: 'rien de prévu ni de fait' }
}
