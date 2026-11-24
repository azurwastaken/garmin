import { Profile, type SetMesg } from '@garmin/fitsdk'
import { Option, Predicate, Schema } from 'effect'

// A strength activity's sets, without I/O, from either source, in the keys of Garmin's exercise
// catalog (exercises.json: LUNGE / DUMBBELL_BULGARIAN_SPLIT_SQUAT):
// - Garmin Connect's /activity-service/activity/{id}/exerciseSets (the sync's
//   connect/strength/YYYY/<id>.json): what the user corrected in Connect after the session wins;
// - the FIT file's `set` messages, as the watch recorded them.
// Only the active sets are kept (a rest is not a set), numbered in their order.

export interface StrengthSet {
  readonly idx: number
  readonly start_time: string | null
  // The catalog's keys; null when the watch did not know the exercise
  readonly category: string | null
  readonly exercise_name: string | null
  readonly reps: number | null
  readonly weight_kg: number | null
  readonly duration_s: number | null
}

// A FIT profile name as the catalog spells it: hipRaise → HIP_RAISE, 3WayCalfRaise →
// _3_WAY_CALF_RAISE (a key never starts with a digit), hangingLSit → HANGING_L_SIT
export const catalogKey = (camel: string) => {
  const snake = camel
    .replaceAll(/([a-z])([A-Z0-9])/gu, '$1_$2')
    .replaceAll(/([A-Z])([A-Z][a-z])/gu, '$1_$2')
    .replaceAll(/([0-9])([A-Za-z])/gu, '$1_$2')
    .toUpperCase()
  return /^\d/u.test(snake) ? `_${snake}` : snake
}

const num = (value: unknown): number | null =>
  Predicate.isNumber(value) && Number.isFinite(value) ? value : null
const positive = (value: unknown) => {
  const n = num(value)
  return n !== null && n > 0 ? n : null
}
const round = (value: number | null, digits: number) =>
  value === null ? null : Math.round(value * 10 ** digits) / 10 ** digits

// Connect's exercise set weight is in grams (the FIT file's in kg): this side of the unit,
// unchecked against a live account, is the one place to fix if a sync proves it wrong
export const connectWeightKg = (grams: unknown) => {
  const weight = positive(grams)
  return weight === null ? null : round(weight / 1000, 2)
}

const ConnectExercise = Schema.Struct({
  category: Schema.optional(Schema.NullOr(Schema.String)),
  name: Schema.optional(Schema.NullOr(Schema.String)),
  probability: Schema.optional(Schema.NullOr(Schema.Number)),
})
const ConnectSet = Schema.Struct({
  setType: Schema.optional(Schema.NullOr(Schema.String)),
  exercises: Schema.optional(Schema.NullOr(Schema.Array(ConnectExercise))),
  repetitionCount: Schema.optional(Schema.NullOr(Schema.Number)),
  weight: Schema.optional(Schema.NullOr(Schema.Number)),
  duration: Schema.optional(Schema.NullOr(Schema.Number)),
  startTime: Schema.optional(Schema.NullOr(Schema.String)),
})
const ConnectSets = Schema.Struct({ exerciseSets: Schema.NullOr(Schema.Array(Schema.Unknown)) })
const decodeSets = Schema.decodeUnknownOption(ConnectSets)
const decodeSet = Schema.decodeUnknownOption(ConnectSet)

// A catalog key Connect gives, or null for its placeholders
const key = (value: string | null | undefined) =>
  value === null || value === undefined || value === '' || value === 'UNKNOWN' ? null : value

// Connect's exerciseSets answer, its active sets; null when it is not one
export const connectSets = (json: unknown): ReadonlyArray<StrengthSet> | null => {
  const answer = decodeSets(json)
  if (Option.isNone(answer)) return null
  const sets = (answer.value.exerciseSets ?? []).flatMap((raw) => {
    const set = Option.getOrUndefined(decodeSet(raw))
    if (set === undefined || (set.setType ?? 'ACTIVE') !== 'ACTIVE') return []
    // Connect guesses: the likeliest exercise first
    const [likeliest] = (set.exercises ?? []).toSorted(
      (a, b) => (b.probability ?? 0) - (a.probability ?? 0)
    )
    const category = key(likeliest?.category)
    return [
      {
        start_time: set.startTime ?? null,
        category,
        exercise_name: category === null ? null : key(likeliest?.name),
        reps: positive(set.repetitionCount),
        weight_kg: connectWeightKg(set.weight),
        duration_s: round(positive(set.duration), 1),
      },
    ]
  })
  return sets.map((set, idx) => ({ idx, ...set }))
}

// The FIT profile's name of a category's exercise (squat 7 → BARBELL_BULGARIAN_SPLIT_SQUAT…)
const exerciseName = (category: string, subtype: number | null): string | null => {
  if (subtype === null) return null
  const names: Readonly<Record<string, string>> | undefined =
    Profile.types[`${category}ExerciseName`]
  const name = names?.[String(subtype)]
  return name === undefined ? null : catalogKey(name)
}

const iso = (value: unknown): string | null =>
  value instanceof Date && !Number.isNaN(value.getTime()) ? value.toISOString() : null

// The FIT file's `set` messages as Garmin's SDK decodes them (its enums as strings), their active
// sets
export const fitSets = (messages: ReadonlyArray<SetMesg>): Array<StrengthSet> =>
  messages
    .filter((set) => String(set.setType) === 'active')
    .map((set, idx) => {
      const first: unknown = set.category?.[0]
      const category =
        typeof first === 'string' && first !== 'unknown' && first !== 'invalid' ? first : null
      return {
        idx,
        start_time: iso(set.startTime),
        category: category === null ? null : catalogKey(category),
        exercise_name:
          category === null ? null : exerciseName(category, num(set.categorySubtype?.[0])),
        reps: positive(set.repetitions),
        weight_kg: round(positive(set.weight), 2),
        duration_s: round(positive(set.duration), 1),
      }
    })
