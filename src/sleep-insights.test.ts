import { describe, expect, it } from 'vitest'

import { addDays } from './days.ts'
import type { Classified } from './nutrition/day-type.ts'
import {
  type Anchor,
  bedtimeBuckets,
  type BedtimeBucket,
  type Best,
  bestOf,
  debtOf,
  dinnerGapBuckets,
  dinnerNights,
  type DurationBucket,
  durationBuckets,
  eveningOf,
  firstDayRead,
  insightsOf,
  type MealTime,
  mealAdviceOf,
  measure,
  type Plateau,
  plateauOf,
  regularityOf,
  type SleptNight,
  sleptOnly,
  startedBy,
  supplementsSince,
  tagsOf,
  tonightOf,
  weekdayWake,
  type Window,
  windowOf,
} from './sleep-insights.ts'

// A Tuesday: the night ending this morning is Monday's
const TODAY = '2026-11-24'
const REST: Classified = { type: 'rest', from: 'nothing', reason: 'rien de prévu ni de fait' }

// 07:00 on the noon axis, 23:00, 7 h
const SEVEN = 1140
const ELEVEN = 660
const H7 = 7 * 3600

const night = (overrides: Partial<SleptNight> = {}): SleptNight => ({
  day: TODAY,
  sleep_start: null,
  sleep_end: null,
  bed_min: ELEVEN,
  wake_min: SEVEN,
  sleep_s: H7,
  awake_s: 1200,
  sleep_score: 80,
  hrv: 40,
  resting_hr: 52,
  body_battery_wake: 80,
  readiness: 70,
  ...overrides,
})

// `count` times the value
const repeat = (count: number, value: number) => Array.from({ length: count }, () => value)

// `count` nights ending on the days before `last` (included), newest first
const nightsBack = (count: number, last: string, overrides: Partial<SleptNight> = {}) =>
  Array.from({ length: count }, (_, index) => night({ day: addDays(last, -index), ...overrides }))

// A duration bucket with this mean score (null: too few nights) and this median sleep
const durationRow = (label: string, score: number | null, median_s = H7): DurationBucket => ({
  label,
  nights: score === null ? 3 : 10,
  median_s,
  from_s: null,
  to_s: null,
  recovery: {
    score:
      score === null ? { kind: 'few', n: 3 } : { kind: 'measured', n: 10, mean: score, ci95: 2 },
    hrv: { kind: 'few', n: 0 },
    resting_hr: { kind: 'few', n: 0 },
    body_battery: { kind: 'few', n: 0 },
    readiness: { kind: 'few', n: 0 },
  },
})

const bedtimeRow = (label: string, score: number | null, to_min: number | null): BedtimeBucket => ({
  ...durationRow(label, score),
  from_min: null,
  to_min,
})

const ANCHOR: Extract<Anchor, { kind: 'anchor' }> = { kind: 'anchor', wake_min: 1143, mornings: 40 }
const PLATEAU: Plateau = {
  label: '7 h 00 – 7 h 30',
  sleep_s: 25_920,
  nights: 16,
  score: 79.4,
  best_score: 82,
}
const best = (to_min: number | null): Best => ({
  label: 'avant 23:30',
  from_min: null,
  to_min,
  score: 80.9,
  nights: 15,
})

describe('sleptOnly', () => {
  it('keeps the nights that have a sleep measured', () => {
    expect(
      sleptOnly([
        { day: 'a', sleep_s: null },
        { day: 'b', sleep_s: 3600 },
      ])
    ).toEqual([{ day: 'b', sleep_s: 3600 }])
  })
})

describe('measure', () => {
  it.each([
    { values: [70, 72, 74, 76], expected: { kind: 'few', n: 4 } },
    { values: [70, 72, null, 74, 76], expected: { kind: 'few', n: 4 } },
    // s = √10, t(4) = 2.78: 2.78 · 3.162 / √5 = 3.93
    { values: [70, 72, 74, 76, 78], expected: { kind: 'measured', n: 5, mean: 74, ci95: 3.9 } },
    {
      values: [80.04, 80.04, 80.04, 80.04, 80.04],
      expected: { kind: 'measured', n: 5, mean: 80, ci95: 0 },
    },
  ])('measures $values', ({ values, expected }) => {
    expect(measure(values)).toEqual(expected)
  })

  // s = 15 · √(n / (n − 1)) or 15: s/√n = 2.69 both times; t(30) = 2.04 at 31 values, 1.96 past
  it.each([
    {
      name: '31 values: t(30)',
      values: [...repeat(15, 60), ...repeat(15, 90), 75],
      ci95: 5.5,
    },
    { name: '32 values: 1.96', values: [...repeat(16, 60), ...repeat(16, 90)], ci95: 5.3 },
  ])('takes $name', ({ values, ci95 }) => {
    expect(measure(values)).toMatchObject({ kind: 'measured', n: values.length, mean: 75, ci95 })
  })
})

describe('the buckets', () => {
  it.each([
    { bed_min: 689, label: 'avant 23:30' },
    { bed_min: 690, label: '23:30–00:30' },
    { bed_min: 749, label: '23:30–00:30' },
    { bed_min: 750, label: '00:30–01:30' },
    { bed_min: 809, label: '00:30–01:30' },
    { bed_min: 810, label: '01:30–02:30' },
    { bed_min: 869, label: '01:30–02:30' },
    { bed_min: 870, label: 'après 02:30' },
  ])('puts asleep at $bed_min min from noon in $label', ({ bed_min, label }) => {
    const buckets = bedtimeBuckets([night({ bed_min })])
    expect(buckets.map((bucket) => bucket.label)).toEqual([
      'avant 23:30',
      '23:30–00:30',
      '00:30–01:30',
      '01:30–02:30',
      'après 02:30',
    ])
    expect(buckets.find((bucket) => bucket.nights === 1)?.label).toBe(label)
  })

  it('leaves a night without a bedtime out', () => {
    expect(bedtimeBuckets([night({ bed_min: null })]).every((bucket) => bucket.nights === 0)).toBe(
      true
    )
  })

  it.each([
    { sleep_s: 21_599, label: 'moins de 6 h 00' },
    { sleep_s: 21_600, label: '6 h 00 – 6 h 30' },
    { sleep_s: 23_399, label: '6 h 00 – 6 h 30' },
    { sleep_s: 23_400, label: '6 h 30 – 7 h 00' },
    { sleep_s: 25_199, label: '6 h 30 – 7 h 00' },
    { sleep_s: 25_200, label: '7 h 00 – 7 h 30' },
    { sleep_s: 26_999, label: '7 h 00 – 7 h 30' },
    { sleep_s: 27_000, label: '7 h 30 – 8 h 00' },
    { sleep_s: 28_799, label: '7 h 30 – 8 h 00' },
    { sleep_s: 28_800, label: '8 h 00 et plus' },
  ])('puts $sleep_s s of sleep in $label', ({ sleep_s, label }) => {
    const bucket = durationBuckets([night({ sleep_s })]).find((b) => b.nights === 1)
    expect(bucket).toMatchObject({ label, median_s: sleep_s })
  })

  it('gives each bucket its edges and its recovery, a mean only from 5 nights', () => {
    const buckets = bedtimeBuckets([
      ...nightsBack(5, TODAY, { bed_min: 600, sleep_score: 82 }),
      ...nightsBack(4, TODAY, { bed_min: 700, sleep_score: 70 }),
    ])
    expect(buckets[0]).toMatchObject({
      from_min: null,
      to_min: 690,
      nights: 5,
      recovery: { score: { kind: 'measured', n: 5, mean: 82 } },
    })
    expect(buckets[1]).toMatchObject({
      from_min: 690,
      to_min: 750,
      nights: 4,
      recovery: { score: { kind: 'few', n: 4 } },
    })
  })
})

describe('plateauOf', () => {
  const labels = ['6 h', '6 h 30', '7 h', '7 h 30', '8 h']
  const rows = (scores: ReadonlyArray<number | null>) =>
    scores.map((score, index) => durationRow(labels[index] ?? '', score, (6 + index / 2) * 3600))

  it.each([
    { name: 'a dip before the best', scores: [78, 70, 79.4, 76], expected: '7 h' },
    { name: 'a drop after the best', scores: [70, 74, 79.4, 80, 72], expected: '7 h' },
    { name: 'scores rising all along', scores: [60, 70, 77.5, 79, 80.5], expected: '7 h' },
    { name: 'exactly 3.0 under, below 64', scores: [63.9, 66.9], expected: '6 h' },
    { name: '3.1 under', scores: [63.8, 66.9], expected: '6 h 30' },
    { name: 'too few nights skipped', scores: [null, 75, null, 76], expected: '6 h 30' },
    { name: 'a tie: the earlier best', scores: [70, 80, 74, 80], expected: '6 h 30' },
  ])('finds the plateau with $name', ({ scores, expected }) => {
    expect(plateauOf(rows(scores))?.label).toBe(expected)
  })

  it('gives the bucket’s median sleep and the best score, or null with nothing measured', () => {
    expect(plateauOf(rows([70, 74, 79.4, 82]))).toEqual({
      label: '7 h',
      sleep_s: 7 * 3600,
      nights: 10,
      score: 79.4,
      best_score: 82,
    })
    expect(plateauOf(rows([null, null]))).toBeNull()
  })
})

describe('bestOf', () => {
  it('takes the best measured bucket, the earlier on a tie', () => {
    expect(
      bestOf([
        bedtimeRow('avant 23:30', 80.9, 690),
        bedtimeRow('23:30–00:30', 80.9, 750),
        bedtimeRow('après 02:30', null, null),
      ])
    ).toEqual({ label: 'avant 23:30', from_min: null, to_min: 690, score: 80.9, nights: 10 })
    expect(bestOf([bedtimeRow('avant 23:30', null, 690)])).toBeNull()
  })
})

describe('the days of the week', () => {
  it.each([
    { day: '2026-11-24', evening: 0 },
    { day: '2026-11-23', evening: 6 },
    { day: '2026-11-22', evening: 5 },
    { day: '2026-11-21', evening: 4 },
  ])('gives the night ending $day the evening $evening', ({ day, evening }) => {
    expect(eveningOf(day)).toBe(evening)
  })

  it('anchors the wake time on the weekday mornings’ median, from 5', () => {
    // Mon 23/11 to Fri 27/11 are weekday mornings; Sat 28 and Sun 29 are not
    const week = ['2026-11-23', '2026-11-24', '2026-11-25', '2026-11-26']
    const four = week.map((day, index) => night({ day, wake_min: SEVEN + index * 10 }))
    const weekend = [night({ day: '2026-11-28', wake_min: 1300 }), night({ day: '2026-11-29' })]
    expect(weekdayWake([...four, ...weekend])).toEqual({ kind: 'few', mornings: 4 })
    expect(
      weekdayWake([...four, night({ day: '2026-11-27', wake_min: 2000 }), ...weekend])
    ).toEqual({ kind: 'anchor', wake_min: SEVEN + 20, mornings: 5 })
  })
})

describe('windowOf', () => {
  it('wakes at the anchor on 5 min and sleeps the plateau and the time awake before', () => {
    // 07:03 → 07:05; 7 h 12 asleep + 20 min awake: 23:33, 23:30 on 5 min
    const window = windowOf({ anchor: ANCHOR, plateau: PLATEAU, awake_s: 1200, best: best(700) })
    expect(window).toMatchObject({ bed_min: 690, wake_min: 1145, clamped_to: null })
    expect(window.sentence).toContain('Levé à 07:05')
    expect(window.sentence).toContain('(40 matins)')
    expect(window.sentence).toContain('7 h 12 de sommeil')
    expect(window.sentence).toContain('79,4 sur 16 nuits')
    expect(window.sentence).toContain('endormi à 23:30')
    expect(window.sentence).toContain('associées au meilleur score (80,9 sur 15 nuits)')
    expect(window.sentence).toContain('ne mesure pas le temps pour s')
  })

  it.each([
    { to_min: 690, bed_min: 685, clamped: true },
    { to_min: 695, bed_min: 690, clamped: false },
    { to_min: null, bed_min: 690, clamped: false },
  ])('never goes past the best bucket’s end ($to_min)', ({ to_min, bed_min, clamped }) => {
    const window = windowOf({ anchor: ANCHOR, plateau: PLATEAU, awake_s: 1200, best: best(to_min) })
    expect(window.bed_min).toBe(bed_min)
    expect(window.clamped_to !== null).toBe(clamped)
    expect(window.sentence.includes('plutôt que 23:30')).toBe(clamped)
  })

  it('says nothing of a best bucket when there is none', () => {
    const window = windowOf({ anchor: ANCHOR, plateau: PLATEAU, awake_s: 1200, best: null })
    expect(window.sentence).not.toContain('meilleur score')
  })
})

describe('debtOf', () => {
  it('sums the target minus the sleep of the 7 nights ending today', () => {
    const nights = [
      night({ day: TODAY, sleep_s: 5 * 3600 }),
      night({ day: addDays(TODAY, -6), sleep_s: 8 * 3600 }),
      // An eighth night back: out
      night({ day: addDays(TODAY, -7), sleep_s: 0 }),
    ]
    expect(debtOf(nights, TODAY, H7)).toEqual({ target_s: H7, nights: 2, debt_s: 3600 })
  })
})

describe('tonightOf', () => {
  const window = windowOf({ anchor: ANCHOR, plateau: PLATEAU, awake_s: 1200, best: null })
  const debt = (debt_s: number) => ({ target_s: window.sleep_s, nights: 7, debt_s })
  const advise = (debt_s: number, last_s: number | null, tomorrow: Classified = REST) =>
    tonightOf({ window: window satisfies Window, debt: debt(debt_s), last_s, tomorrow })

  it.each([
    { name: 'nothing', debt_s: 0, last_s: null, tomorrow: REST, reasons: [] },
    { name: 'a debt of 1 h 59', debt_s: 7199, last_s: null, tomorrow: REST, reasons: [] },
    {
      name: 'a debt of 2 h',
      debt_s: 7200,
      last_s: null,
      tomorrow: REST,
      reasons: ['2 h 00 de dette sur les 7 dernières nuits'],
    },
    { name: 'a night 59 min short', debt_s: 0, last_s: 25_920 - 3599, tomorrow: REST, reasons: [] },
    {
      name: 'a night 1 h short',
      debt_s: 0,
      last_s: 25_920 - 3600,
      tomorrow: REST,
      reasons: ['nuit dernière courte (6 h 12)'],
    },
    {
      name: 'an easy day tomorrow',
      debt_s: 0,
      last_s: null,
      tomorrow: { type: 'easy', from: 'planned', reason: 'séance prévue sans intensité' },
      reasons: [],
    },
    {
      name: 'a quality day tomorrow',
      debt_s: 0,
      last_s: null,
      tomorrow: { type: 'quality', from: 'planned', reason: 'seuil' },
      reasons: ['demain, séance de qualité (seuil)'],
    },
    {
      name: 'a long day tomorrow',
      debt_s: 0,
      last_s: null,
      tomorrow: { type: 'long', from: 'planned', reason: '1 h 30 prévus' },
      reasons: ['demain, sortie longue (1 h 30 prévus)'],
    },
  ] satisfies ReadonlyArray<{
    name: string
    debt_s: number
    last_s: number | null
    tomorrow: Classified
    reasons: ReadonlyArray<string>
  }>)('moves tonight for $name: $reasons', ({ debt_s, last_s, tomorrow, reasons }) => {
    const tonight = advise(debt_s, last_s, tomorrow)
    const earlier = reasons.length === 0 ? 0 : 30
    expect(tonight.reasons).toEqual(reasons)
    expect(tonight.earlier_min).toBe(earlier)
    expect(tonight.bed_min).toBe(window.bed_min - earlier)
  })

  it.each([
    { debt_s: 7199, last_s: 25_920, said: 'dette sous 2 h 00, nuit dernière pas courte' },
    { debt_s: 0, last_s: null, said: 'nuit dernière pas encore synchronisée' },
  ])(
    'says what holds when nothing moves tonight ($debt_s, $last_s)',
    ({ debt_s, last_s, said }) => {
      const tonight = advise(debt_s, last_s)
      expect(tonight.sentence).toContain(said)
      expect(tonight.sentence).toContain('pas de grosse séance demain')
    }
  )

  it('names every reason, and never more than 30 min earlier', () => {
    const tonight = advise(4 * 3600, 3 * 3600, {
      type: 'long',
      from: 'planned',
      reason: '1 h 30 prévus',
    })
    expect(tonight.earlier_min).toBe(30)
    expect(tonight.reasons).toEqual([
      '4 h 00 de dette sur les 7 dernières nuits',
      'nuit dernière courte (3 h 00)',
      'demain, sortie longue (1 h 30 prévus)',
    ])
    expect(tonight.sentence).toContain('30 min plus tôt')
  })
})

describe('mealAdviceOf', () => {
  it.each([
    // 00:30 and 07:30: dinner by 22:30 the evening before, breakfast from 10:30
    ['a bedtime after midnight', 750, 1170, 630, 1350, ['22:30', '10:30'], ['07:30', '08:30']],
    ['a bedtime before it', 660, 1110, 540, 1260, ['21:00', '09:00'], ['06:30', '07:30']],
    // 02:30: dinner by 00:30, breakfast from 12:30 (past the axis's end)
    ['a very late bedtime', 870, 1260, 750, 1470, ['00:30', '12:30'], ['09:00', '10:00']],
  ] as const)(
    'puts dinner 2 h before %s, breakfast 12 h after, light in the hour after waking',
    (_, bed_min, wake_min, dinner_by, breakfast_from, dinnerClocks, lightClocks) => {
      const advice = mealAdviceOf({ bed_min, wake_min })
      expect(advice).toMatchObject({
        dinner_by,
        breakfast_from,
        light_from: wake_min,
        light_to: wake_min + 60,
      })
      for (const clock of dinnerClocks) expect(advice.dinner_sentence).toContain(clock)
      expect(advice.dinner_sentence).toContain('preuves modestes')
      expect(advice.light_sentence).toContain(`entre ${lightClocks[0]} et ${lightClocks[1]}`)
      expect(advice.light_sentence).toContain('10 à 20 min')
    }
  )
})

// A night ending on `day` (the morning), asleep and awake at those instants
const slept = (day: string, sleep_start: string | null, sleep_end: string | null) =>
  night({ day, sleep_start, sleep_end })
const meal = (time: string, kind: MealTime['kind'] = 'dinner') => ({ time, kind }) as MealTime

describe('dinnerNights', () => {
  // Asleep 00:30, awake 07:30 in Paris (UTC+1)
  const NIGHT = slept(TODAY, '2026-11-23T23:30:00.000Z', '2026-11-24T06:30:00.000Z')

  it('measures the gap to sleep and the fast across midnight, on instants', () => {
    // Dinner 20:00, breakfast 07:45: 4 h 30 to sleep, 11 h 45 without eating
    expect(
      dinnerNights(
        [NIGHT],
        [
          meal('2026-11-23T11:30:00.000Z', 'lunch'),
          meal('2026-11-23T19:00:00.000Z'),
          meal('2026-11-24T06:45:00.000Z', 'breakfast'),
        ]
      )
    ).toEqual([
      {
        night: TODAY,
        dinner: '2026-11-23T19:00:00.000Z',
        gap_s: 16_200,
        fast_s: 42_300,
        sleep_score: 80,
        hrv: 40,
        resting_hr: 52,
      },
    ])
  })

  it('takes the later of two dinners, and starts the fast at a snack after it', () => {
    const [found] = dinnerNights(
      [NIGHT],
      [
        meal('2026-11-23T18:00:00.000Z'),
        meal('2026-11-23T20:00:00.000Z'),
        meal('2026-11-23T22:00:00.000Z', 'snack'),
        meal('2026-11-24T07:00:00.000Z', 'breakfast'),
      ]
    )
    expect(found).toMatchObject({ dinner: '2026-11-23T20:00:00.000Z', gap_s: 12_600 })
    // From the 23:00 snack to the 08:00 breakfast
    expect(found?.fast_s).toBe(9 * 3600)
  })

  it('ignores a meal between falling asleep and waking, for the dinner and for the fast', () => {
    // Asleep 22:30, a snack logged at 23:30 the same evening, a dinner 15 min after falling asleep
    const early = slept(TODAY, '2026-11-23T21:30:00.000Z', '2026-11-24T06:30:00.000Z')
    const [found] = dinnerNights(
      [early],
      [
        meal('2026-11-23T18:30:00.000Z'),
        meal('2026-11-23T21:45:00.000Z'),
        meal('2026-11-23T22:30:00.000Z', 'snack'),
        meal('2026-11-24T07:30:00.000Z', 'breakfast'),
      ]
    )
    expect(found).toMatchObject({ dinner: '2026-11-23T18:30:00.000Z', gap_s: 3 * 3600 })
    expect(found?.fast_s).toBe(13 * 3600)
  })

  it('counts on instants across the night the clocks go back', () => {
    // Dinner 22:00 CEST on the 24th, asleep 02:30 CET (the second one), breakfast 08:00 CET: on the
    // wall clock 4 h 30 and 10 h, in fact 5 h 30 and 11 h
    const [found] = dinnerNights(
      [slept('2026-10-25', '2026-10-25T01:30:00.000Z', '2026-10-25T06:30:00.000Z')],
      [meal('2026-10-24T20:00:00.000Z'), meal('2026-10-25T07:00:00.000Z', 'breakfast')]
    )
    expect(found).toMatchObject({ gap_s: 19_800, fast_s: 39_600 })
  })

  it.each([
    ['without a dinner', [meal('2026-11-23T19:00:00.000Z', 'snack')], NIGHT],
    ['after a dinner over 12 h before', [meal('2026-11-23T11:00:00.000Z')], NIGHT],
    ['after a dinner exactly 12 h before', [meal('2026-11-23T11:30:00.000Z')], NIGHT],
    ['after a dinner past sleep onset', [meal('2026-11-23T23:45:00.000Z')], NIGHT],
    [
      'without its sleep onset',
      [meal('2026-11-23T19:00:00.000Z')],
      slept(TODAY, null, '2026-11-24T06:30:00.000Z'),
    ],
  ] as const)('leaves out a night %s', (_, meals, one) => {
    expect(dinnerNights([one], meals)).toEqual([])
  })

  it('keeps a dinner logged at the very instant of falling asleep', () => {
    expect(dinnerNights([NIGHT], [meal('2026-11-23T23:30:00.000Z')])).toMatchObject([
      { dinner: '2026-11-23T23:30:00.000Z', gap_s: 0 },
    ])
  })

  it.each([
    ['its wake time', slept(TODAY, '2026-11-23T23:30:00.000Z', null), '2026-11-24T07:00:00.000Z'],
    // The next meal 12 h after waking
    ['a meal in the 12 h after waking', NIGHT, '2026-11-24T18:30:00.000Z'],
  ] as const)('has no fast without %s', (_, one, next) => {
    const [found] = dinnerNights([one], [meal('2026-11-23T19:00:00.000Z'), meal(next, 'lunch')])
    expect(found).toMatchObject({ gap_s: 16_200, fast_s: null })
  })
})

describe('dinnerGapBuckets', () => {
  // A night ending `days` before today, asleep at 00:00 Paris, after a dinner `gap_s` before
  const dinnerAt = (days: number, gap_s: number, score: number) => {
    const day = addDays(TODAY, -days)
    const onset = Date.parse(`${addDays(day, -1)}T23:00:00.000Z`)
    return {
      night: { ...slept(day, new Date(onset).toISOString(), null), sleep_score: score },
      dinner: meal(new Date(onset - gap_s * 1000).toISOString()),
    }
  }

  it('splits the nights at 2 h and 3 h, an edge in the bucket it opens', () => {
    const set = [
      dinnerAt(0, 7199, 70),
      dinnerAt(1, 7200, 80),
      dinnerAt(2, 10_799, 80),
      dinnerAt(3, 10_800, 90),
    ]
    const nights = set.map((one) => one.night)
    const buckets = dinnerGapBuckets(
      // A night without a dinner is in none
      [...nights, night({ day: addDays(TODAY, -4) })],
      dinnerNights(
        nights,
        set.map((one) => one.dinner)
      )
    )
    expect(
      buckets.map((bucket) => [bucket.label, bucket.nights, bucket.from_s, bucket.to_s])
    ).toEqual([
      ['moins de 2 h 00', 1, null, 7200],
      ['2 h 00 – 3 h 00', 2, 7200, 10_800],
      ['3 h 00 et plus', 1, 10_800, null],
    ])
    expect(buckets[1]?.recovery.score).toEqual({ kind: 'few', n: 2 })
  })

  it('measures a bucket from 5 nights', () => {
    const set = [80, 82, 84, 86, 88].map((score, days) => dinnerAt(days, 3 * 3600, score))
    const nights = set.map((one) => one.night)
    const [, , late] = dinnerGapBuckets(
      nights,
      dinnerNights(
        nights,
        set.map((one) => one.dinner)
      )
    )
    // Mean 84, SD 3.16: t(4) 2.78 · 3.16 / √5 = 3.9
    expect(late?.recovery.score).toEqual({ kind: 'measured', n: 5, mean: 84, ci95: 3.9 })
  })
})

describe('regularityOf', () => {
  it.each([
    { beds: [600, 610, null, 620, 630], expected: { kind: 'few', nights: 4 } },
    // 600…640: population SD √200 = 14.1
    { beds: [600, 610, 620, 630, 640], expected: { kind: 'measured', nights: 5, minutes: 14 } },
  ])('spreads the bedtimes $beds', ({ beds, expected }) => {
    const nights = beds.map((bed_min, index) => night({ day: addDays(TODAY, -index), bed_min }))
    expect(regularityOf(nights).bed_sd).toEqual(expected)
  })

  // Fridays' and Saturdays' nights end on Saturdays and Sundays
  const weekendDays = ['2026-11-21', '2026-11-22', '2026-11-14', '2026-11-15', '2026-11-08']
  const weekdays = ['2026-11-23', '2026-11-24', '2026-11-25', '2026-11-26', '2026-11-27']

  it('measures the weekend’s shift from 5 mid-sleeps on each side', () => {
    const late = weekendDays.map((day) =>
      night({ day, bed_min: ELEVEN + 120, wake_min: SEVEN + 120 })
    )
    const usual = weekdays.map((day) => night({ day }))
    expect(regularityOf([...late, ...usual]).social_jetlag).toEqual({
      kind: 'measured',
      minutes: 120,
      weekend: 5,
      weekday: 5,
    })
    const gap = [...late.slice(1), night({ day: weekendDays[0], bed_min: null }), ...usual]
    expect(regularityOf(gap).social_jetlag).toEqual({ kind: 'few', weekend: 4, weekday: 5 })
    const weekdayGap = [...late, ...usual.slice(1), night({ day: weekdays[0], wake_min: null })]
    expect(regularityOf(weekdayGap).social_jetlag).toEqual({ kind: 'few', weekend: 5, weekday: 4 })
  })

  it('splits the nights by their evening', () => {
    const rows = regularityOf([
      night({ day: '2026-11-24', bed_min: 700 }),
      night({ day: '2026-12-01', bed_min: 720 }),
    ]).weekdays
    expect(rows.map((row) => row.label)).toEqual([
      'lundi',
      'mardi',
      'mercredi',
      'jeudi',
      'vendredi',
      'samedi',
      'dimanche',
    ])
    expect(rows[0]).toEqual({
      evening: 0,
      label: 'lundi',
      nights: 2,
      bed_min: 710,
      score: { kind: 'few', n: 2 },
    })
    expect(rows[1]).toMatchObject({ nights: 0, bed_min: null })
  })
})

describe('the tags', () => {
  it('dates the supplements from their earliest note, whatever the order', () => {
    expect(
      supplementsSince(
        [
          { time: '2026-11-22T20:00:00.000Z', day: '2026-11-22', text: 'ashwagandha ce soir' },
          {
            time: '2026-11-25T08:00:00.000Z',
            day: '2026-11-20',
            text: 'magnésium (écrit plus tard)',
          },
          { time: '2026-11-19T20:00:00.000Z', day: '2026-11-19', text: 'run facile' },
        ],
        []
      )
    ).toBe('2026-11-20')
    expect(
      supplementsSince(
        [{ time: '2026-11-19T20:00:00.000Z', day: '2026-11-19', text: 'run facile' }],
        []
      )
    ).toBeNull()
  })

  it.each([
    { start: '2026-11-18', expected: '2026-11-18' },
    { start: '2026-11-21', expected: '2026-11-20' },
  ])(
    'dates them from a start on $start, the earlier of it and the notes',
    ({ start, expected }) => {
      const note = { time: '2026-11-20T20:00:00.000Z', day: '2026-11-20', text: 'Ashwa+ ce soir' }
      expect(supplementsSince([note], [{ name: 'Ashwa+', start }])).toBe(expected)
      expect(supplementsSince([], [{ name: 'Ashwa+', start }])).toBe(start)
    }
  )

  it('reads the starts begun by today, of the supplements named for sleep', () => {
    expect(
      startedBy(
        [
          { name: 'Ashwa+', start: '2026-11-23' },
          { name: 'Magnésium Taurine B6', start: TODAY },
          // Not yet begun
          { name: 'Mélatonine', start: addDays(TODAY, 1) },
          // Not one the tags follow, as a note naming it would not be
          { name: 'Vitamine D3', start: '2026-11-01' },
        ],
        TODAY
      ).map((supplement) => supplement.name)
    ).toEqual(['Ashwa+', 'Magnésium Taurine B6'])
  })

  // Supplements first noted on 23/11: the before side starts on 27/10
  const NOTES = [
    {
      time: '2026-11-23T20:00:00.000Z',
      day: '2026-11-23',
      text: "Première prise d'Ashwa+ ce soir",
    },
  ]

  it.each([
    { from: '2026-10-26', expected: '2026-10-26' },
    { from: '2026-10-27', expected: '2026-10-27' },
    { from: '2026-10-28', expected: '2026-10-27' },
  ])('reads from $expected for a span from $from', ({ from, expected }) => {
    expect(firstDayRead(from, '2026-11-23')).toBe(expected)
    expect(firstDayRead(from, null)).toBe(from)
  })

  it.each([
    { text: "Première prise d'Ashwa+ d'ESN", tags: ['supplements'] },
    { text: 'avec le magnésium Nutripure', tags: ['supplements'] },
    { text: 'deux bières au bar', tags: ['alcohol'] },
    { text: 'un verre de vin', tags: ['alcohol'] },
    { text: 'pas mal d’alcool hier soir', tags: ['alcohol'] },
    { text: 'bière sans alcool', tags: [] },
    { text: "pas d'alcool ce soir", tags: [] },
    { text: "pas bu d'alcool hier", tags: [] },
    { text: 'run facile, vingt minutes', tags: [] },
  ])('tags "$text"', ({ text, tags }) => {
    const found = tagsOf({
      notes: [{ time: `${TODAY}T20:00:00.000Z`, day: TODAY, text }],
      started: [],
      from: TODAY,
      span: [],
      history: [],
    })
    expect(found.nights.map((tagged) => tagged.tags)).toEqual(tags.length === 0 ? [] : [tags])
  })

  it('shows a tagged note with the night after it, from the span’s first day on', () => {
    const tags = tagsOf({
      notes: [
        { time: '2026-11-23T20:00:00.000Z', day: '2026-11-23', text: 'Ashwa+ ce soir' },
        { time: '2026-11-01T20:00:00.000Z', day: '2026-11-01', text: 'une bière' },
      ],
      started: [],
      from: '2026-11-10',
      span: [night({ day: '2026-11-24', sleep_score: 70, hrv: 39, resting_hr: 52 })],
      history: [],
    })
    // A note the day before the span: its night is the span's first, listed
    const edge = tagsOf({
      notes: [
        { time: '2026-11-09T20:00:00.000Z', day: '2026-11-09', text: 'une bière' },
        // Its night, the 9th, is the day before the span: out
        { time: '2026-11-08T20:00:00.000Z', day: '2026-11-08', text: 'une bière' },
      ],
      started: [],
      from: '2026-11-10',
      span: [],
      history: [],
    })
    expect(edge.nights.map((tagged) => tagged.night)).toEqual(['2026-11-10'])
    expect(tags.nights).toEqual([
      {
        source: 'journal',
        time: '2026-11-23T20:00:00.000Z',
        text: 'Ashwa+ ce soir',
        tags: ['supplements'],
        day: '2026-11-23',
        started: [],
        night: '2026-11-24',
        sleep_score: 70,
        hrv: 39,
        resting_hr: 52,
      },
    ])
    expect(tags.supplements).toEqual({
      kind: 'too-few',
      first_night: '2026-11-24',
      before: 0,
      after: 1,
      needed: 14,
    })
  })

  describe('with the supplements file', () => {
    const BOTH = [
      { name: 'Ashwa+', start: '2026-11-23' },
      { name: 'Magnésium Taurine B6', start: '2026-11-23' },
    ]
    const span = [night({ day: '2026-11-24', sleep_score: 70, hrv: 39, resting_hr: 52 })]

    it('folds a start into the note naming it that day: one night, both names', () => {
      const tags = tagsOf({ notes: NOTES, started: BOTH, from: '2026-11-10', span, history: [] })
      expect(tags.nights).toEqual([
        {
          source: 'journal',
          time: '2026-11-23T20:00:00.000Z',
          text: "Première prise d'Ashwa+ ce soir",
          tags: ['supplements'],
          day: '2026-11-23',
          started: ['Ashwa+', 'Magnésium Taurine B6'],
          night: '2026-11-24',
          sleep_score: 70,
          hrv: 39,
          resting_hr: 52,
        },
      ])
    })

    it('gives the starts to the day’s earliest supplements note, whatever the order', () => {
      const tags = tagsOf({
        notes: [
          { time: '2026-11-23T21:00:00.000Z', day: '2026-11-23', text: 'et le magnésium' },
          { time: '2026-11-23T20:00:00.000Z', day: '2026-11-23', text: 'Ashwa+ ce soir' },
        ],
        started: BOTH,
        from: '2026-11-10',
        span,
        history: [],
      })
      expect(
        tags.nights.map((tagged) => [tagged.source === 'journal' && tagged.time, tagged.started])
      ).toEqual([
        ['2026-11-23T20:00:00.000Z', ['Ashwa+', 'Magnésium Taurine B6']],
        ['2026-11-23T21:00:00.000Z', []],
      ])
    })

    it('gives a start without a note a night of its own, in night order', () => {
      const tags = tagsOf({
        notes: [
          { time: '2026-11-15T20:00:00.000Z', day: '2026-11-15', text: 'une bière' },
          { time: '2026-11-05T20:00:00.000Z', day: '2026-11-05', text: 'une bière' },
        ],
        started: [{ name: 'Ashwa+', start: '2026-11-10' }],
        from: '2026-11-01',
        span: [],
        history: [],
      })
      expect(tags.nights.map((tagged) => [tagged.night, tagged.source, tagged.started])).toEqual([
        ['2026-11-06', 'journal', []],
        ['2026-11-11', 'supplements', ['Ashwa+']],
        ['2026-11-16', 'journal', []],
      ])
      expect(tags.supplements).toMatchObject({ kind: 'too-few', first_night: '2026-11-11' })
    })

    it('keeps a start beside a note naming no supplement, after it on their night', () => {
      const tags = tagsOf({
        notes: [{ time: '2026-11-10T20:00:00.000Z', day: '2026-11-10', text: 'une bière' }],
        started: [{ name: 'Ashwa+', start: '2026-11-10' }],
        from: '2026-11-01',
        span: [],
        history: [],
      })
      expect(tags.nights.map((tagged) => [tagged.night, tagged.source, tagged.started])).toEqual([
        ['2026-11-11', 'journal', []],
        ['2026-11-11', 'supplements', ['Ashwa+']],
      ])
    })

    it('leaves out a start whose night is before the span', () => {
      const tags = tagsOf({
        notes: [],
        started: [{ name: 'Ashwa+', start: '2026-11-08' }],
        from: '2026-11-10',
        span: [],
        history: [],
      })
      expect(tags.nights).toEqual([])
      expect(tags.supplements).toMatchObject({ first_night: '2026-11-09' })
    })
  })

  it('compares 14 nights after the first note with the 28 days before', () => {
    const after = nightsBack(14, '2026-12-07', { hrv: 46 })
    const before = nightsBack(14, '2026-11-23', { hrv: 40 })
    // A night 29 days before the first night after: out of the before side
    const old = night({ day: '2026-10-26', hrv: 10 })
    // The before side's first night: in
    const first = night({ day: '2026-10-27', hrv: 40 })
    const compared = tagsOf({
      notes: NOTES,
      started: [],
      from: '2026-11-24',
      span: after,
      history: [old, first, ...before],
    })
    expect(compared.supplements).toMatchObject({
      kind: 'compared',
      first_night: '2026-11-24',
      before: { nights: 15, hrv: { kind: 'measured', mean: 40 } },
      after: { nights: 14, hrv: { kind: 'measured', mean: 46 } },
    })
    const short = tagsOf({
      notes: NOTES,
      started: [],
      from: '2026-11-24',
      span: after.slice(1),
      history: before,
    })
    expect(short.supplements).toMatchObject({ kind: 'too-few', before: 14, after: 13 })
    const shortBefore = tagsOf({
      notes: NOTES,
      started: [],
      from: '2026-11-24',
      span: after,
      history: before.slice(1),
    })
    expect(shortBefore.supplements).toMatchObject({ kind: 'too-few', before: 13, after: 14 })
  })
})

describe('insightsOf', () => {
  // 70 nights: weekday nights asleep at 23:15 for 7 h 15, Fridays and Saturdays at 01:45 for 6 h
  const span = Array.from({ length: 70 }, (_, index) => {
    const day = addDays(TODAY, -index)
    const weekend = eveningOf(day) >= 4 && eveningOf(day) <= 5
    return weekend
      ? night({
          day,
          bed_min: 825,
          wake_min: 1200,
          sleep_s: 6 * 3600,
          sleep_score: 60 + (index % 3),
        })
      : night({ day, bed_min: 675, wake_min: 1125, sleep_s: 26_100, sleep_score: 80 + (index % 3) })
  })

  it('points to a window, a debt and tonight’s advice', () => {
    const insights = insightsOf({
      from: addDays(TODAY, -69),
      today: TODAY,
      span,
      history: [],
      tomorrow: REST,
      notes: [],
      started: [],
      meals: [],
    })
    expect(insights).toMatchObject({ from: addDays(TODAY, -69), to: TODAY, nights: 70 })
    expect(insights.plan).toMatchObject({
      kind: 'plan',
      // 06:45; 7 h 15 + 20 min before: 23:10
      window: { wake_min: 1125, bed_min: 670, sleep_s: 26_100, clamped_to: null },
      // Two weekend nights 1 h 15 short
      debt: { nights: 7, debt_s: 9000 },
      tonight: { earlier_min: 30, reasons: ['2 h 30 de dette sur les 7 dernières nuits'] },
    })
    expect(insights.regularity.social_jetlag).toMatchObject({ kind: 'measured', minutes: 113 })
    expect(insights.tags).toEqual({ nights: [], supplements: null })
    // Tonight's meals from tonight's bedtime: 23:10 − 30 min
    if (insights.plan.kind !== 'plan') return expect.fail('no plan')
    expect(insights.plan.meal_timing).toEqual(mealAdviceOf(insights.plan.tonight))
    expect(insights.plan.meal_timing).toMatchObject({ dinner_by: 520, light_from: 1125 })
    // No meal logged: three empty buckets
    expect(insights.dinner.nights).toEqual([])
    expect(insights.dinner.gap.map((bucket) => bucket.nights)).toEqual([0, 0, 0])
  })

  it('says what is missing for the window', () => {
    const insights = insightsOf({
      from: TODAY,
      today: TODAY,
      span: span.slice(0, 3).map((n) => ({ ...n, awake_s: null })),
      history: [],
      tomorrow: REST,
      notes: [],
      started: [],
      meals: [],
    })
    expect(insights.plan).toEqual({
      kind: 'too-few',
      missing: ['plateau', 'anchor', 'awake'],
      // Tuesday's and Monday's mornings: Sunday's ends a Saturday night
      mornings: 2,
      reason:
        "Pas assez de nuits : aucune tranche de durée n'a 5 nuits avec un score, 2 réveils en semaine sur les 5 qu'il faut, pas de temps d'éveil mesuré.",
    })
  })
})
