import { MIN_NIGHTS, TAG_BEFORE_DAYS } from './api/periods.ts'
import { clock, fmt, hours } from './components/format.ts'
import { addDays, earlierDay } from './days.ts'
import { mean, median, present, round, spread } from './numbers.ts'
import type { Classified } from './nutrition/day-type.ts'
import type { Supplement } from './nutrition/supplements.ts'
import type { SleepNight } from './stats.ts'

// The sleep page's analysis and the coach's (sleep_insights), without I/O: recovery by bedtime and
// by duration, the window they point to, how regular the nights are, the week's debt, tonight's
// advice and the nights the journal and the supplements' first days tag. Descriptive only: under 5
// nights a bucket says nothing, every number carries its n, and a difference is "associé à", never
// a cause.

// A night with its sleep measured; its day is the morning it ends, bed_min and wake_min are on the
// noon axis (minutes from noon the day before, Paris time: see stats.ts withClock)
export type SleptNight = Pick<
  SleepNight,
  | 'day'
  | 'bed_min'
  | 'wake_min'
  | 'awake_s'
  | 'sleep_score'
  | 'hrv'
  | 'resting_hr'
  | 'body_battery_wake'
  | 'readiness'
> & { readonly sleep_s: number }

// A journal note (the pains pinned on the body map left out): time is the instant written, its key
export interface Note {
  readonly time: string
  readonly day: string
  readonly text: string
}

// Score points under which a longer sleep no longer counts as better
const PLATEAU_POINTS = 3
// Nights on each side of a "since" comparison
const TAG_MIN_NIGHTS = 14
// Tonight earlier from a 7-night debt of 2 h, or after a night 1 h short of the target
const DEBT_LIMIT_S = 2 * 3600
const SHORT_NIGHT_S = 3600
// Half an hour at most: much earlier than usual rarely falls asleep any sooner
const EARLIER_MIN = 30
// What makes tomorrow a day to sleep earlier for, by its type; null: nothing
const HARD_DAY: Record<Classified['type'], string | null> = {
  rest: null,
  easy: null,
  quality: 'séance de qualité',
  long: 'sortie longue',
}

export type Measured =
  | { readonly kind: 'few'; readonly n: number }
  | { readonly kind: 'measured'; readonly n: number; readonly mean: number; readonly ci95: number }

export interface Recovery {
  readonly score: Measured
  readonly hrv: Measured
  readonly resting_hr: Measured
  readonly body_battery: Measured
  readonly readiness: Measured
}

interface Bucket {
  readonly label: string
  readonly nights: number
  // The nights' median sleep
  readonly median_s: number | null
  readonly recovery: Recovery
}

// Asleep from `from_min` (inclusive) to `to_min` (exclusive), on the noon axis; null: open
export interface BedtimeBucket extends Bucket {
  readonly from_min: number | null
  readonly to_min: number | null
}

// From `from_s` of sleep (inclusive) to `to_s` (exclusive); null: open
export interface DurationBucket extends Bucket {
  readonly from_s: number | null
  readonly to_s: number | null
}

export interface Plateau {
  readonly label: string
  // The bucket's median sleep: the duration aimed for
  readonly sleep_s: number
  readonly nights: number
  readonly score: number
  // The best duration bucket's mean score
  readonly best_score: number
}

export interface Best {
  readonly label: string
  readonly from_min: number | null
  readonly to_min: number | null
  readonly score: number
  readonly nights: number
}

export type Anchor =
  | { readonly kind: 'few'; readonly mornings: number }
  | { readonly kind: 'anchor'; readonly wake_min: number; readonly mornings: number }

export interface Window {
  // Asleep by, on the noon axis, on 5 minutes
  readonly bed_min: number
  // The weekday wake time, rounded to 5 minutes
  readonly wake_min: number
  readonly sleep_s: number
  // The median time awake in a night, between falling asleep and waking
  readonly awake_s: number
  readonly anchor: Extract<Anchor, { kind: 'anchor' }>
  readonly plateau: Plateau
  readonly best: Best | null
  // The bucket whose end pulled the bedtime back, else null
  readonly clamped_to: Best | null
  readonly sentence: string
}

export interface Debt {
  readonly target_s: number
  // The nights measured among the last 7
  readonly nights: number
  // Target minus slept over them: positive, a deficit; negative, a surplus
  readonly debt_s: number
}

export interface Tonight {
  readonly bed_min: number
  readonly wake_min: number
  readonly earlier_min: 0 | typeof EARLIER_MIN
  readonly reasons: ReadonlyArray<string>
  readonly sentence: string
}

export type Plan =
  | {
      readonly kind: 'too-few'
      readonly missing: ReadonlyArray<'plateau' | 'anchor' | 'awake'>
      readonly mornings: number
      readonly reason: string
    }
  | {
      readonly kind: 'plan'
      readonly window: Window
      readonly debt: Debt
      readonly tonight: Tonight
    }

export type Spread =
  | { readonly kind: 'few'; readonly nights: number }
  | { readonly kind: 'measured'; readonly nights: number; readonly minutes: number }

// weekend and weekday count the mid-sleeps (nights with both times)
export type Jetlag =
  | { readonly kind: 'few'; readonly weekend: number; readonly weekday: number }
  | {
      readonly kind: 'measured'
      // The weekend's mean mid-sleep minus the weekdays': positive, later on weekends
      readonly minutes: number
      readonly weekend: number
      readonly weekday: number
    }

export interface WeekdayRow {
  // The evening's weekday, 0 Monday … 6 Sunday
  readonly evening: number
  readonly label: string
  readonly nights: number
  readonly bed_min: number | null
  readonly score: Measured
}

export interface Regularity {
  readonly bed_sd: Spread
  readonly wake_sd: Spread
  readonly social_jetlag: Jetlag
  readonly weekdays: ReadonlyArray<WeekdayRow>
}

export type Tag = 'supplements' | 'alcohol'

// A supplement of data/nutrition/supplements.json, as the tags read it: its name and first day
export type Started = Pick<Supplement, 'name' | 'start'>

// A night tagged by a journal note (source 'journal', its time its key), or by supplements begun
// that day without a note naming one (source 'supplements')
export type TaggedNight = {
  readonly tags: ReadonlyArray<Tag>
  // The day the note is about, or the supplements' first day
  readonly day: string
  // The night after it: the one ending the next morning
  readonly night: string
  // The supplements of data/nutrition/supplements.json begun that day
  readonly started: ReadonlyArray<string>
  readonly sleep_score: number | null
  readonly hrv: number | null
  readonly resting_hr: number | null
} & (
  | { readonly source: 'journal'; readonly time: string; readonly text: string }
  | { readonly source: 'supplements' }
)

export interface Side {
  readonly nights: number
  readonly score: Measured
  readonly hrv: Measured
  readonly resting_hr: Measured
}

export type Since =
  | {
      readonly kind: 'too-few'
      readonly first_night: string
      readonly before: number
      readonly after: number
      readonly needed: number
    }
  | {
      readonly kind: 'compared'
      readonly first_night: string
      readonly before: Side
      readonly after: Side
    }

export interface Tags {
  readonly nights: ReadonlyArray<TaggedNight>
  readonly supplements: Since | null
}

export interface SleepInsights {
  readonly from: string
  readonly to: string
  readonly nights: number
  readonly bedtime: ReadonlyArray<BedtimeBucket>
  readonly duration: ReadonlyArray<DurationBucket>
  readonly plan: Plan
  readonly regularity: Regularity
  readonly tags: Tags
}

// 23:30, 00:30, 01:30 and 02:30 on the noon axis
const BEDTIME_EDGES = [690, 750, 810, 870]
// 6 h to 8 h by half-hours
const DURATION_EDGES = [6, 6.5, 7, 7.5, 8].map((h) => h * 3600)
const EVENINGS = ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche']
// Student's t for a two-sided 95 % interval, 1 to 30 degrees of freedom; 1.96 past them
const T95 = [
  12.71, 4.3, 3.18, 2.78, 2.57, 2.45, 2.36, 2.31, 2.26, 2.23, 2.2, 2.18, 2.16, 2.14, 2.13, 2.12,
  2.11, 2.1, 2.09, 2.09, 2.08, 2.07, 2.07, 2.06, 2.06, 2.06, 2.05, 2.05, 2.05, 2.04,
]

const SUPPLEMENTS = /ashwa|magn[ée]sium|m[ée]latonine/iu
const ALCOHOL = /alcool|bi[èe]re|\bvins?\b|ap[ée]ro|whisky|cocktail|champagne|rhum|vodka/iu
// shortcut: a note with a drink and its negation ("deux bières, la dernière sans alcool") loses
// its tag; upgrade to a tag the note carries if that matters
const NO_ALCOHOL =
  /sans (?:boire d['’])?alcool|pas (?:bu |pris )?d['’]alcool|z[ée]ro alcool|aucun alcool/iu

// To one decimal
const tenth = (value: number) => Math.round(value * 10) / 10
// A count of tenths, for comparisons without float error
const inTenths = (value: number) => Math.round(value * 10)
// Down to 5 minutes
const floorTo5 = (minutes: number) => Math.floor(minutes / 5) * 5
// To the nearest 5 minutes
const roundTo5 = (minutes: number) => Math.round(minutes / 5) * 5

// The nights that have a sleep measured
export const sleptOnly = <N extends { readonly sleep_s: number | null }>(
  nights: ReadonlyArray<N>
): Array<N & { readonly sleep_s: number }> =>
  nights.filter((night): night is N & { readonly sleep_s: number } => night.sleep_s !== null)

// The mean of the values there, its n and its 95 % half-width t(n−1)·s/√n (s the sample SD), both
// to one decimal; too few under MIN_NIGHTS values
export const measure = (values: ReadonlyArray<number | null>): Measured => {
  const known = present(values)
  const average = mean(known)
  if (average === null || known.length < MIN_NIGHTS) return { kind: 'few', n: known.length }
  const sd = Math.sqrt(
    known.reduce((sum, value) => sum + (value - average) ** 2, 0) / (known.length - 1)
  )
  const t = T95[known.length - 2] ?? 1.96
  return {
    kind: 'measured',
    n: known.length,
    mean: tenth(average),
    ci95: tenth((t * sd) / Math.sqrt(known.length)),
  }
}

// The recovery measures of a set of nights
const recoveryOf = (nights: ReadonlyArray<SleptNight>): Recovery => ({
  score: measure(nights.map((night) => night.sleep_score)),
  hrv: measure(nights.map((night) => night.hrv)),
  resting_hr: measure(nights.map((night) => night.resting_hr)),
  body_battery: measure(nights.map((night) => night.body_battery_wake)),
  readiness: measure(nights.map((night) => night.readiness)),
})

// The nights split by consecutive edges, [from, to), open below the first and above the last; a
// night without the value is in none
const bucketsOf = (
  nights: ReadonlyArray<SleptNight>,
  edges: ReadonlyArray<number>,
  value: (night: SleptNight) => number | null
) =>
  [null, ...edges].map((from, index) => {
    const to = edges[index] ?? null
    return {
      from,
      to,
      nights: nights.filter((night) => {
        const at = value(night)
        return at !== null && (from === null || at >= from) && (to === null || at < to)
      }),
    }
  })

// A bucket's numbers, whatever its axis
const bucketOf = (label: string, nights: ReadonlyArray<SleptNight>): Bucket => ({
  label,
  nights: nights.length,
  median_s: median(nights.map((night) => night.sleep_s)),
  recovery: recoveryOf(nights),
})

// "avant 23:30", "23:30–00:30", "après 02:30"
const clockSpan = (from: number | null, to: number | null) => {
  if (from === null) return `avant ${clock(to ?? 0)}`
  if (to === null) return `après ${clock(from)}`
  return `${clock(from)}–${clock(to)}`
}

// "moins de 6 h 00", "6 h 00 – 6 h 30", "8 h 00 et plus"
const hoursSpan = (from: number | null, to: number | null) => {
  if (from === null) return `moins de ${hours(to ?? 0)}`
  if (to === null) return `${hours(from)} et plus`
  return `${hours(from)} – ${hours(to)}`
}

// Nights by the time they fell asleep: before 23:30, hour by hour to 02:30, then after
export const bedtimeBuckets = (nights: ReadonlyArray<SleptNight>): Array<BedtimeBucket> =>
  bucketsOf(nights, BEDTIME_EDGES, (night) => night.bed_min).map(({ from, to, nights: part }) => ({
    ...bucketOf(clockSpan(from, to), part),
    from_min: from,
    to_min: to,
  }))

// Nights by the sleep they had: under 6 h, half-hour by half-hour to 8 h, then 8 h and more
export const durationBuckets = (nights: ReadonlyArray<SleptNight>): Array<DurationBucket> =>
  bucketsOf(nights, DURATION_EDGES, (night) => night.sleep_s).map(({ from, to, nights: part }) => ({
    ...bucketOf(hoursSpan(from, to), part),
    from_s: from,
    to_s: to,
  }))

// Where more sleep stops helping: the shortest measured duration bucket at or before the best one
// from which every measured bucket up to the best stays within PLATEAU_POINTS of it, on the
// one-decimal means shown (compared in tenths, exactly); null when none is measured
export const plateauOf = (buckets: ReadonlyArray<DurationBucket>): Plateau | null => {
  const measured = buckets.flatMap((bucket) =>
    bucket.recovery.score.kind === 'measured' && bucket.median_s !== null
      ? [{ bucket, score: bucket.recovery.score.mean, sleep_s: bucket.median_s }]
      : []
  )
  const top = Math.max(...measured.map((m) => m.score))
  // The best bucket, the earlier on a tie
  const best = measured.findIndex((m) => m.score === top)
  const close = (m: { readonly score: number }) =>
    inTenths(top) - inTenths(m.score) <= PLATEAU_POINTS * 10
  const start = measured.findIndex((_, at) => measured.slice(at, best + 1).every((m) => close(m)))
  const found = measured[start]
  if (found === undefined) return null
  return {
    label: found.bucket.label,
    sleep_s: found.sleep_s,
    nights: found.bucket.nights,
    score: found.score,
    best_score: top,
  }
}

// The bedtime bucket with the best mean score shown (one decimal, 5 nights or more), the earlier
// one on a tie
export const bestOf = (buckets: ReadonlyArray<BedtimeBucket>): Best | null =>
  buckets.reduce<Best | null>((best, bucket) => {
    const score = bucket.recovery.score
    if (score.kind !== 'measured' || (best !== null && score.mean <= best.score)) return best
    return {
      label: bucket.label,
      from_min: bucket.from_min,
      to_min: bucket.to_min,
      score: score.mean,
      nights: bucket.nights,
    }
  }, null)

// The weekday of a night's evening, 0 Monday … 6 Sunday: its day is the morning after
export const eveningOf = (day: string) => (new Date(`${day}T00:00:00Z`).getUTCDay() + 5) % 7

// Friday's and Saturday's nights
const weekendNight = (night: SleptNight) => eveningOf(night.day) >= 4 && eveningOf(night.day) <= 5

// The median wake time of the weekday mornings (Monday to Friday), from 5 mornings
export const weekdayWake = (nights: ReadonlyArray<SleptNight>): Anchor => {
  const wakes = present(nights.filter((night) => !weekendNight(night)).map((n) => n.wake_min))
  const wake = median(wakes)
  return wake === null || wakes.length < MIN_NIGHTS
    ? { kind: 'few', mornings: wakes.length }
    : { kind: 'anchor', wake_min: wake, mornings: wakes.length }
}

// "20 min", or "1 h 05" past the hour
const minutesText = (minutes: number) =>
  minutes < 60 ? `${Math.round(minutes)} min` : hours(minutes * 60)

// A bedtime bucket in a sentence: "avant 23:30", "entre 23:30 et 00:30", "après 02:30"
const bedtimePhrase = ({ from_min, to_min }: Best) =>
  from_min !== null && to_min !== null
    ? `entre ${clock(from_min)} et ${clock(to_min)}`
    : clockSpan(from_min, to_min)

// The bucket whose end comes before the bedtime computed: the bedtime is pulled back inside it
const clampOf = (best: Best | null, computed: number) =>
  best !== null && best.to_min !== null && computed >= best.to_min
    ? { best, bed: best.to_min - 5 }
    : null

// The window in French, with its numbers and their n
const windowSentence = ({
  wake,
  bed,
  computed,
  anchor,
  plateau,
  awake_s,
  best,
}: {
  readonly wake: number
  readonly bed: number
  // The bedtime before the best bucket pulled it back (the same when it didn't)
  readonly computed: number
  readonly anchor: Extract<Anchor, { kind: 'anchor' }>
  readonly plateau: Plateau
  readonly awake_s: number
  readonly best: Best | null
}) => {
  const pulled = bed === computed ? '' : `, d'où ${clock(bed)} plutôt que ${clock(computed)}`
  const bestText =
    best === null
      ? ''
      : ` Tes nuits commencées ${bedtimePhrase(best)} sont associées au meilleur score (${fmt(best.score, 1)} sur ${best.nights} nuits)${pulled}.`
  return (
    `Levé à ${clock(wake)}, la médiane de tes réveils en semaine (${anchor.mornings} matins). ` +
    `Au-delà de ${hours(plateau.sleep_s)} de sommeil, le score ne monte presque plus (tranche ${plateau.label} : ${fmt(plateau.score, 1)} sur ${plateau.nights} nuits, ${fmt(plateau.best_score, 1)} au mieux). ` +
    `Avec ${minutesText(awake_s / 60)} d'éveil par nuit en médiane, endormi à ${clock(bed)}.${bestText} ` +
    `Garmin ne mesure pas le temps pour s'endormir : éteins un peu avant.`
  )
}

// The window: up at the weekday wake time, asleep the plateau's sleep and the median time awake
// before it, and never later than the end of the best bedtime bucket
export const windowOf = ({
  anchor,
  plateau,
  awake_s,
  best,
}: {
  readonly anchor: Extract<Anchor, { kind: 'anchor' }>
  readonly plateau: Plateau
  readonly awake_s: number
  readonly best: Best | null
}): Window => {
  const wake = roundTo5(anchor.wake_min)
  const computed = floorTo5(wake - (plateau.sleep_s + awake_s) / 60)
  const clamp = clampOf(best, computed)
  const bed = clamp?.bed ?? computed
  return {
    bed_min: bed,
    wake_min: wake,
    sleep_s: plateau.sleep_s,
    awake_s,
    anchor,
    plateau,
    best,
    clamped_to: clamp?.best ?? null,
    sentence: windowSentence({ wake, bed, computed, anchor, plateau, awake_s, best }),
  }
}

// The deficit of the 7 nights ending today against the target, over the nights measured
export const debtOf = (
  nights: ReadonlyArray<SleptNight>,
  today: string,
  target_s: number
): Debt => {
  const week = nights.filter((night) => night.day > addDays(today, -7) && night.day <= today)
  return {
    target_s,
    nights: week.length,
    debt_s: Math.round(week.reduce((sum, night) => sum + target_s - night.sleep_s, 0)),
  }
}

// Tonight: the window, half an hour earlier after a heavy week, a short night (last_s: the night
// ending today, null until it syncs) or before a quality or long day
export const tonightOf = ({
  window,
  debt,
  last_s,
  tomorrow,
}: {
  readonly window: Window
  readonly debt: Debt
  readonly last_s: number | null
  readonly tomorrow: Classified
}): Tonight => {
  const hard = HARD_DAY[tomorrow.type]
  const reasons = present([
    debt.debt_s >= DEBT_LIMIT_S
      ? `${hours(debt.debt_s)} de dette sur les ${debt.nights} dernières nuits`
      : null,
    last_s !== null && last_s <= window.sleep_s - SHORT_NIGHT_S
      ? `nuit dernière courte (${hours(last_s)})`
      : null,
    hard === null ? null : `demain, ${hard} (${tomorrow.reason})`,
  ])
  const earlier_min = reasons.length > 0 ? EARLIER_MIN : 0
  const bed = window.bed_min - earlier_min
  return {
    bed_min: bed,
    wake_min: window.wake_min,
    earlier_min,
    reasons,
    sentence:
      earlier_min === 0
        ? `Ce soir, endormi à ${clock(bed)} pour un lever à ${clock(window.wake_min)} : dette sous ${hours(DEBT_LIMIT_S)}, ${last_s === null ? 'nuit dernière pas encore synchronisée' : 'nuit dernière pas courte'}, pas de grosse séance demain.`
        : `Ce soir, endormi à ${clock(bed)}, ${EARLIER_MIN} min plus tôt, pour un lever à ${clock(window.wake_min)} : ${reasons.join(' ; ')}. Pas plus tôt : bien avant son heure, on s'endort rarement plus vite.`,
  }
}

// Why the window can't be computed, in French
const tooFewReason = (plateau: Plateau | null, anchor: Anchor, awake_s: number | null) =>
  `Pas assez de nuits : ${present([
    plateau === null ? `aucune tranche de durée n'a ${MIN_NIGHTS} nuits avec un score` : null,
    anchor.kind === 'few'
      ? `${anchor.mornings} réveil${anchor.mornings > 1 ? 's' : ''} en semaine sur les ${MIN_NIGHTS} qu'il faut`
      : null,
    awake_s === null ? "pas de temps d'éveil mesuré" : null,
  ]).join(', ')}.`

// The window, the debt and tonight's advice, or what is missing for them
const planOf = ({
  plateau,
  anchor,
  awake_s,
  best,
  nights,
  today,
  tomorrow,
}: {
  readonly plateau: Plateau | null
  readonly anchor: Anchor
  readonly awake_s: number | null
  readonly best: Best | null
  readonly nights: ReadonlyArray<SleptNight>
  readonly today: string
  readonly tomorrow: Classified
}): Plan => {
  if (plateau === null || anchor.kind === 'few' || awake_s === null) {
    return {
      kind: 'too-few',
      missing: present([
        plateau === null ? ('plateau' as const) : null,
        anchor.kind === 'few' ? ('anchor' as const) : null,
        awake_s === null ? ('awake' as const) : null,
      ]),
      mornings: anchor.mornings,
      reason: tooFewReason(plateau, anchor, awake_s),
    }
  }
  const window = windowOf({ anchor, plateau, awake_s, best })
  const debt = debtOf(nights, today, window.sleep_s)
  const last_s = nights.find((night) => night.day === today)?.sleep_s ?? null
  return { kind: 'plan', window, debt, tonight: tonightOf({ window, debt, last_s, tomorrow }) }
}

// The population SD of the times there, in whole minutes, from MIN_NIGHTS
const spreadOf = (minutes: ReadonlyArray<number | null>): Spread => {
  const values = present(minutes)
  const sd = values.length < MIN_NIGHTS ? null : round(spread(values))
  return sd === null
    ? { kind: 'few', nights: values.length }
    : { kind: 'measured', nights: values.length, minutes: sd }
}

// The mid-sleeps, on the noon axis, of the nights that have both times
const midSleeps = (nights: ReadonlyArray<SleptNight>) =>
  nights.flatMap((night) =>
    night.bed_min === null || night.wake_min === null ? [] : [(night.bed_min + night.wake_min) / 2]
  )

// The weekend's mean mid-sleep against the weekdays', in whole minutes, from MIN_NIGHTS each
const jetlagOf = (nights: ReadonlyArray<SleptNight>): Jetlag => {
  const weekend = midSleeps(nights.filter((night) => weekendNight(night)))
  const weekday = midSleeps(nights.filter((night) => !weekendNight(night)))
  const late = mean(weekend)
  const usual = mean(weekday)
  const shift =
    late === null || usual === null || weekend.length < MIN_NIGHTS || weekday.length < MIN_NIGHTS
      ? null
      : round(late - usual)
  return shift === null
    ? { kind: 'few', weekend: weekend.length, weekday: weekday.length }
    : { kind: 'measured', minutes: shift, weekend: weekend.length, weekday: weekday.length }
}

// The nights of one evening of the week: their count, median bedtime and score
const weekdayRow = (
  nights: ReadonlyArray<SleptNight>,
  evening: number,
  label: string
): WeekdayRow => {
  const those = nights.filter((night) => eveningOf(night.day) === evening)
  return {
    evening,
    label,
    nights: those.length,
    bed_min: round(median(present(those.map((night) => night.bed_min)))),
    score: measure(those.map((night) => night.sleep_score)),
  }
}

// How regular the nights are: the spread of bedtimes and wake times, the weekend's shift (social
// jetlag) and each evening of the week
export const regularityOf = (nights: ReadonlyArray<SleptNight>): Regularity => ({
  bed_sd: spreadOf(nights.map((night) => night.bed_min)),
  wake_sd: spreadOf(nights.map((night) => night.wake_min)),
  social_jetlag: jetlagOf(nights),
  weekdays: EVENINGS.map((label, evening) => weekdayRow(nights, evening, label)),
})

// The tags a note's words carry
const tagsIn = (text: string): Array<Tag> =>
  present([
    SUPPLEMENTS.test(text) ? ('supplements' as const) : null,
    ALCOHOL.test(text) && !NO_ALCOHOL.test(text) ? ('alcohol' as const) : null,
  ])

// The starts the tags read: begun by `today`, named as a sleep supplement, as the notes are
export const startedBy = (supplements: ReadonlyArray<Started>, today: string): Array<Started> =>
  supplements.filter((supplement) => supplement.start <= today && SUPPLEMENTS.test(supplement.name))

// The notes naming a supplement
const supplementNotes = (notes: ReadonlyArray<Note>) =>
  notes.filter((note) => SUPPLEMENTS.test(note.text))

// The earliest of the first note naming a supplement and the first start, whatever their order
export const supplementsSince = (
  notes: ReadonlyArray<Note>,
  started: ReadonlyArray<Started>
): string | null =>
  [
    ...supplementNotes(notes).map((note) => note.day),
    ...started.map((supplement) => supplement.start),
  ].reduce<string | null>((first, day) => (first === null ? day : earlierDay(first, day)), null)

// The first night of the before side, for supplements first noted on `since`
const beforeFrom = (since: string) => addDays(since, 1 - TAG_BEFORE_DAYS)

// The first day the analysis reads: the span's first, or the before side of the supplements begun
// on `since` when it starts earlier
export const firstDayRead = (from: string, since: string | null) =>
  since === null ? from : earlierDay(from, beforeFrom(since))

// A side of a "since" comparison
const sideOf = (nights: ReadonlyArray<SleptNight>): Side => ({
  nights: nights.length,
  score: measure(nights.map((night) => night.sleep_score)),
  hrv: measure(nights.map((night) => night.hrv)),
  resting_hr: measure(nights.map((night) => night.resting_hr)),
})

// The nights after the supplements' first note against the 28 days before, from 14 nights each
const sinceOf = (since: string, nights: ReadonlyArray<SleptNight>): Since => {
  const first_night = addDays(since, 1)
  const before = nights.filter((night) => night.day >= beforeFrom(since) && night.day < first_night)
  const after = nights.filter((night) => night.day >= first_night)
  return before.length < TAG_MIN_NIGHTS || after.length < TAG_MIN_NIGHTS
    ? {
        kind: 'too-few',
        first_night,
        before: before.length,
        after: after.length,
        needed: TAG_MIN_NIGHTS,
      }
    : { kind: 'compared', first_night, before: sideOf(before), after: sideOf(after) }
}

// The names begun on each day
const startsByDay = (started: ReadonlyArray<Started>) =>
  new Map(
    Array.from(
      Map.groupBy(started, (supplement) => supplement.start),
      ([day, begun]) => [day, begun.map((supplement) => supplement.name)]
    )
  )

// The time of each day's earliest note naming a supplement: the one that carries its starts
const firstSupplementNotes = (notes: ReadonlyArray<Note>) =>
  new Set(
    Array.from(Map.groupBy(supplementNotes(notes), (note) => note.day).values(), (ofDay) =>
      ofDay.reduce((first, note) => (note.time < first.time ? note : first))
    ).map((note) => note.time)
  )

// The night after `day` and its numbers, from the nights by day
const nightAfter = (day: string, byDay: ReadonlyMap<string, SleptNight>) => {
  const night = addDays(day, 1)
  const slept = byDay.get(night)
  return {
    night,
    sleep_score: slept?.sleep_score ?? null,
    hrv: slept?.hrv ?? null,
    resting_hr: slept?.resting_hr ?? null,
  }
}

// By night; on a night, the notes by time, then a day supplements began without one
const orderOf = (tagged: TaggedNight) =>
  `${tagged.night} ${tagged.source === 'journal' ? `0 ${tagged.time}` : '1'}`

// The tagged notes and the days supplements began without a note, each with the night after it
// from `from` on, and the supplements' comparison over the history and the span
export const tagsOf = ({
  notes,
  started,
  from,
  span,
  history,
}: {
  readonly notes: ReadonlyArray<Note>
  readonly started: ReadonlyArray<Started>
  readonly from: string
  readonly span: ReadonlyArray<SleptNight>
  readonly history: ReadonlyArray<SleptNight>
}): Tags => {
  const byDay = new Map(span.map((night) => [night.day, night]))
  const starts = startsByDay(started)
  const carriers = firstSupplementNotes(notes)
  const noted = new Set(supplementNotes(notes).map((note) => note.day))
  const since = supplementsSince(notes, started)
  const journal = notes.flatMap((note): Array<TaggedNight> => {
    const tags = tagsIn(note.text)
    if (tags.length === 0) return []
    const begun = carriers.has(note.time) ? (starts.get(note.day) ?? []) : []
    return [
      {
        source: 'journal',
        time: note.time,
        text: note.text,
        tags,
        day: note.day,
        started: begun,
        ...nightAfter(note.day, byDay),
      },
    ]
  })
  const unnoted = Array.from(starts)
    .filter(([day]) => !noted.has(day))
    .map(([day, begun]): TaggedNight => ({
      source: 'supplements',
      tags: ['supplements'],
      day,
      started: begun,
      ...nightAfter(day, byDay),
    }))
  return {
    nights: [...journal, ...unnoted]
      .filter((tagged) => tagged.night >= from)
      .toSorted((a, b) => (orderOf(a) < orderOf(b) ? -1 : 1)),
    supplements: since === null ? null : sinceOf(since, [...history, ...span]),
  }
}

// The whole analysis: `span` the nights from `from` to `today`, `history` the nights before it
// that the supplements' before side reads, `started` the supplements begun (startedBy)
export const insightsOf = ({
  from,
  today,
  span,
  history,
  tomorrow,
  notes,
  started,
}: {
  readonly from: string
  readonly today: string
  readonly span: ReadonlyArray<SleptNight>
  readonly history: ReadonlyArray<SleptNight>
  readonly tomorrow: Classified
  readonly notes: ReadonlyArray<Note>
  readonly started: ReadonlyArray<Started>
}): SleepInsights => {
  const bedtime = bedtimeBuckets(span)
  const duration = durationBuckets(span)
  return {
    from,
    to: today,
    nights: span.length,
    bedtime,
    duration,
    plan: planOf({
      plateau: plateauOf(duration),
      anchor: weekdayWake(span),
      awake_s: median(present(span.map((night) => night.awake_s))),
      best: bestOf(bedtime),
      nights: span,
      today,
      tomorrow,
    }),
    regularity: regularityOf(span),
    tags: tagsOf({ notes, started, from, span, history }),
  }
}
