import { Schema } from 'effect'

import { EXERCISES } from '../garmin/workout-builder.ts'

import { MODEL_MUSCLES_AND_TENDONS } from './structures.ts'

// The strength programme agreed with the coach, without I/O: data/strength/program.json (the
// source of truth, as every file of data/), read on each request and never copied into SQLite, as
// the nutrition plan. Without the file, the runner's programme of 2026-11-24 below.
//
// What it rests on:
// - Heavy and plyometric strength training improves running economy in trained runners
//   (Balsalobre-Fernández, Santos-Concejero & Grivas 2016, J Strength Cond Res 30(8):2361-2368,
//   a meta-analysis of controlled trials): heavy loads, few reps, then plyometrics, twice a week.
// - Heavy slow resistance (3 s down, 3 s up, 15RM towards 6RM, 3 times a week in the trial) heals
//   patellar tendinopathy as well as eccentric decline squats, with better satisfaction and lasting
//   results (Kongsgaard et al. 2009, Scand J Med Sci Sports 19(6):790-802): the 3-0-3 tempo of
//   session A, for the right knee's tendinitis of autumn 2026.
// - The pain rule: a structure loaded with a pain of 3/10 or more in the last 14 days takes the
//   exercise's regression. Stricter than the pain-monitoring model's 5/10 (Silbernagel et al.
//   2007, Am J Sports Med 35(6):897-906), as agreed for a knee that is still talking.

// Its own helpers, as nutrition/plan.ts: this module must not load the API's
const Day = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/u))
const Text = (max: number) => Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(max))
const IntBetween = (minimum: number, maximum: number) =>
  Schema.Int.check(Schema.isBetween({ minimum, maximum }))
const Slug = Schema.String.check(Schema.isPattern(/^[a-z0-9_]{1,40}$/u))

export const PROGRAM_PATH = 'strength/program.json'

// The programme's phases, tied to the races' dates
export const PHASE_KINDS = ['base', 'build', 'taper', 'mont-blanc'] as const
export type PhaseKind = (typeof PHASE_KINDS)[number]
// The phases an exercise has a dose of its own for (a taper takes another phase's, halved)
export const DOSED_PHASES = ['build', 'mont-blanc'] as const

export type StructureId = (typeof MODEL_MUSCLES_AND_TENDONS)[number]
const MODEL_IDS: ReadonlySet<string> = new Set(MODEL_MUSCLES_AND_TENDONS)
export const StructureIdJson = Schema.String.check(
  Schema.makeFilter(
    (id) => MODEL_IDS.has(id) || `${id} : pas un muscle ni un tendon du modèle anatomique`
  )
)

const CATALOG_KEYS: ReadonlySet<string> = new Set(
  EXERCISES.map((entry) => `${entry.category}/${entry.exercise}`)
)

// Garmin's catalog entry the watch shows: the exercise itself (exact), or the closest one when the
// catalog has none (a step-down, a Copenhagen plank, a Nordic curl): the step's note names it then
const GarminKeyJson = Schema.Struct({
  category: Text(60),
  exercise_name: Text(80),
  match: Schema.Literals(['exact', 'closest']),
}).check(
  Schema.makeFilter(
    (key) =>
      CATALOG_KEYS.has(`${key.category}/${key.exercise_name}`) ||
      `${key.category}/${key.exercise_name} : pas dans le catalogue Garmin (find_exercises)`
  )
)
export type GarminKey = typeof GarminKeyJson.Type

// One phase's dose: sets of reps or of seconds (exactly one), the tempo, the load in words
const DoseJson = Schema.Struct({
  sets: IntBetween(1, 10),
  reps: Schema.optionalKey(IntBetween(1, 60)),
  seconds: Schema.optionalKey(IntBetween(5, 300)),
  tempo: Schema.optionalKey(
    Text(20).annotate({ description: 'Down-pause-up in seconds, e.g. "3-0-3" (heavy slow)' })
  ),
  load: Text(200).annotate({ description: 'The load cue: RPE, reps in reserve, a weight' }),
}).check(
  Schema.makeFilter(
    (dose) =>
      (dose.reps === undefined) !== (dose.seconds === undefined) ||
      'dose : exactement un de reps ou seconds'
  )
)
export type Dose = typeof DoseJson.Type

const ExerciseJson = Schema.Struct({
  id: Slug,
  name: Text(80).annotate({ description: "The exercise's French name" }),
  garmin: GarminKeyJson,
  // The base phase's dose, and the build's and Mont-Blanc's when they differ
  dose: DoseJson,
  by_phase: Schema.optionalKey(
    Schema.Struct({
      build: Schema.optionalKey(DoseJson),
      'mont-blanc': Schema.optionalKey(DoseJson),
    })
  ),
  per_side: Schema.Boolean.annotate({ description: 'Each set once per leg or side' }),
  rest_s: IntBetween(0, 600),
  primary: Schema.Array(StructureIdJson).check(Schema.isMinLength(1)),
  secondary: Schema.Array(StructureIdJson),
  // Only in these phases (pogo hops once the knee is quiet); every phase without it
  phases: Schema.optionalKey(Schema.Array(Schema.Literals(PHASE_KINDS))),
  cue: Text(300).annotate({ description: 'How to do it, in French' }),
  regression: Text(300).annotate({ description: 'What to do instead under the pain rule' }),
  // At the parents' (no gym): the same muscles with a bodyweight, a band or a backpack
  maison: Schema.NullOr(
    Schema.Struct({ name: Text(80), garmin: GarminKeyJson, load: Text(200) })
  ).annotate({ description: 'The home variant; null: the same exercise works at home' }),
})
export type Exercise = typeof ExerciseJson.Type

const PhaseJson = Schema.Struct({
  kind: Schema.Literals(PHASE_KINDS),
  from: Day,
  // Its last day, included
  to: Day,
  label: Text(120),
  // Whose doses it takes: its own, or the build's in a taper
  doses: Schema.Literals(['base', ...DOSED_PHASES]),
  // The sets × this (a taper's 0.5), rounded, one at least
  volume: Schema.Finite.check(Schema.isBetween({ minimum: 0.25, maximum: 2 })),
  note: Text(300),
}).check(Schema.makeFilter((phase) => phase.from <= phase.to || 'phase : from ≤ to'))
export type Phase = typeof PhaseJson.Type

const SessionJson = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^[A-Z]$/u)),
  name: Text(40),
  focus: Text(200),
  exercises: Schema.Array(Slug).check(Schema.isMinLength(1), Schema.isMaxLength(12)),
})
export type Session = typeof SessionJson.Type

export const StrengthProgramJson = Schema.Struct({
  agreed: Day.annotate({ description: 'The day it was agreed, YYYY-MM-DD' }),
  sessions_per_week: IntBetween(1, 4),
  min_hours_apart: IntBetween(24, 96),
  pain_rule: Schema.Struct({
    threshold: IntBetween(1, 10).annotate({ description: 'A pain this high (0-10) or more' }),
    days: IntBetween(1, 60).annotate({ description: 'within the last days' }),
  }),
  phases: Schema.Array(PhaseJson).annotate({
    description: 'In date order, never overlapping; a day in none has no session (a recovery week)',
  }),
  sessions: Schema.Array(SessionJson).check(Schema.isMinLength(1), Schema.isMaxLength(4)),
  exercises: Schema.Array(ExerciseJson).check(Schema.isMinLength(1), Schema.isMaxLength(40)),
}).check(Schema.makeFilter(programMismatch))
export type StrengthProgram = typeof StrengthProgramJson.Type

// Why the programme does not hold together, or true: phases in order, ids unique, every session's
// exercise defined
function programMismatch(program: {
  readonly phases: ReadonlyArray<Pick<Phase, 'from' | 'to'>>
  readonly sessions: ReadonlyArray<Pick<Session, 'id' | 'exercises'>>
  readonly exercises: ReadonlyArray<Pick<Exercise, 'id'>>
}): true | string {
  if (!program.phases.every((phase, index) => (program.phases[index - 1]?.to ?? '') < phase.from)) {
    return 'phases : dans l’ordre des dates, sans chevauchement'
  }
  const ids = program.exercises.map((exercise) => exercise.id)
  const twice = ids.find((id, index) => ids.indexOf(id) !== index)
  if (twice !== undefined) return `exercises : ${twice} deux fois`
  const sessionIds = program.sessions.map((session) => session.id)
  if (new Set(sessionIds).size !== sessionIds.length) return 'sessions : un id deux fois'
  const known = new Set(ids)
  const missing = program.sessions.flatMap((session) =>
    session.exercises.filter((id) => !known.has(id)).map((id) => `${session.id} → ${id}`)
  )
  return missing.length === 0 || `sessions : exercices inconnus (${missing.join(', ')})`
}

// --- The default programme, 2026-11-24

// The model's structures that have a left one: their names without the side
type Bilateral = {
  readonly [Id in StructureId]: Id extends `${infer Name}_l` ? Name : never
}[StructureId]

// A muscle or tendon of both legs (or both sides of the trunk): its two ids, the name checked by
// the type (the right one by the schema, the model being symmetric)
const both = (...names: ReadonlyArray<Bilateral>): Array<StructureId> =>
  names.flatMap((name): Array<StructureId> => [`${name}_l`, `${name}_r` as StructureId])

const QUADS = both('vastus_medialis', 'vastus_lateralis', 'vastus_intermedius', 'rectus_femoris')
const HAMSTRINGS = both(
  'long_head_of_biceps_femoris',
  'short_head_of_biceps_femoris',
  'semitendinosus',
  'semimembranosus'
)
const GASTROCNEMIUS = both('medial_head_of_gastrocnemius', 'lateral_head_of_gastrocnemius')
const OBLIQUES = both('external_abdominal_oblique', 'internal_abdominal_oblique')
const ADDUCTORS = both('adductor_longus', 'adductor_brevis', 'adductor_magnus', 'gracilis')

const garmin = (key: string, match: GarminKey['match'] = 'exact'): GarminKey => {
  const [category = '', exercise_name = ''] = key.split('/')
  return { category, exercise_name, match }
}

export const DEFAULT_PROGRAM: StrengthProgram = {
  agreed: '2026-11-24',
  sessions_per_week: 2,
  min_hours_apart: 48,
  pain_rule: { threshold: 3, days: 14 },
  phases: [
    {
      kind: 'base',
      from: '2026-11-24',
      to: '2026-12-06',
      label: 'Base : réapprendre les mouvements',
      doses: 'base',
      volume: 1,
      note: 'Charges modérées, tempo lent, la douleur du genou ≤ 3/10 pendant et le lendemain.',
    },
    {
      kind: 'build',
      from: '2026-12-07',
      to: '2027-03-20',
      label: 'Bloc marathon de Paris',
      doses: 'build',
      volume: 1,
      note: 'Plus lourd, moins de répétitions (RPE 8) ; pogo hops si le genou est calme.',
    },
    {
      kind: 'taper',
      from: '2027-03-21',
      to: '2027-04-04',
      label: 'Affûtage, marathon de Paris le 4 avril',
      doses: 'build',
      volume: 0.5,
      note: 'Moitié des séries, mêmes charges ; rien de nouveau, dernière séance à J-5 au plus tard.',
    },
    // 2027-04-05 to 04-11: no phase, the week after the marathon is a recovery week
    {
      kind: 'mont-blanc',
      from: '2027-04-12',
      to: '2027-06-13',
      label: 'Marathon du Mont-Blanc (2 500 m D-), si tiré au sort',
      doses: 'mont-blanc',
      volume: 1,
      note: 'Plus d’excentrique des quadriceps : step-downs lents et lestés pour les descentes.',
    },
    {
      kind: 'taper',
      from: '2027-06-14',
      to: '2027-06-27',
      label: 'Affûtage, Mont-Blanc le 27 juin',
      doses: 'mont-blanc',
      volume: 0.5,
      note: 'Moitié des séries ; garde les step-downs, sans courbatures la dernière semaine.',
    },
  ],
  sessions: [
    {
      id: 'A',
      name: 'Lourd et lent',
      focus: 'Tendon rotulien et quadriceps : lourd, tempo 3-0-3, excentrique',
      exercises: [
        'split_squat',
        'step_down',
        'romanian_deadlift',
        'calf_raise_straight',
        'calf_raise_bent',
        'dead_bug',
      ],
    },
    {
      id: 'B',
      name: 'Hanches et chaîne postérieure',
      focus: 'Moyen fessier, adducteurs, ischios, gainage ; plus tard un peu de pliométrie',
      exercises: [
        'side_plank_abduction',
        'copenhagen_plank',
        'single_leg_bridge',
        'nordic_curl',
        'pallof_press',
        'pogo_hops',
      ],
    },
  ],
  exercises: [
    {
      id: 'split_squat',
      name: 'Fente bulgare',
      garmin: garmin('LUNGE/DUMBBELL_BULGARIAN_SPLIT_SQUAT'),
      dose: { sets: 3, reps: 10, tempo: '3-0-3', load: 'RPE 7 : 3 répétitions en réserve' },
      by_phase: {
        build: { sets: 4, reps: 6, tempo: '3-0-3', load: 'RPE 8 : 2 en réserve, plus lourd' },
        'mont-blanc': { sets: 3, reps: 8, tempo: '4-0-2', load: 'RPE 8, descente 4 s' },
      },
      per_side: true,
      rest_s: 120,
      primary: [...QUADS, ...both('gluteus_maximus')],
      secondary: both(
        'adductor_magnus',
        'gluteus_medius',
        'quadriceps_tendon',
        'patellar_ligament'
      ),
      cue: 'Pied arrière sur un banc, genou avant dans l’axe du pied, descente 3 s, remontée 3 s.',
      regression:
        'Fente statique au poids du corps, amplitude réduite (genou à 60°), sans douleur.',
      maison: {
        name: 'Fente bulgare, sac à dos lesté',
        garmin: garmin('LUNGE/DUMBBELL_BULGARIAN_SPLIT_SQUAT', 'closest'),
        load: 'Sac à dos de 8–12 kg, RPE 7',
      },
    },
    {
      id: 'step_down',
      name: 'Step-down lent (excentrique)',
      garmin: garmin('SQUAT/PARTIAL_SINGLE_LEG_SQUAT', 'closest'),
      dose: { sets: 3, reps: 8, tempo: '4-0-1', load: 'Poids du corps, marche de 15–20 cm' },
      by_phase: {
        build: { sets: 3, reps: 8, tempo: '4-0-1', load: 'Haltères 2×6–8 kg, marche de 20 cm' },
        'mont-blanc': {
          sets: 4,
          reps: 10,
          tempo: '5-0-1',
          load: 'Haltères 2×8–12 kg, marche de 25 cm : les descentes du Mont-Blanc',
        },
      },
      per_side: true,
      rest_s: 90,
      primary: [
        ...both('vastus_medialis', 'vastus_lateralis', 'rectus_femoris'),
        ...both('patellar_ligament'),
      ],
      secondary: both(
        'vastus_intermedius',
        'quadriceps_tendon',
        'gluteus_medius',
        'gluteus_maximus'
      ),
      cue: 'Debout sur une marche, le talon libre descend toucher le sol en 4 s, genou au-dessus du 2e orteil, bassin horizontal.',
      regression:
        'Marche plus basse (10 cm) et descente 3 s, ou isométrique : chaise contre le mur 5 × 45 s.',
      maison: null,
    },
    {
      id: 'romanian_deadlift',
      name: 'Soulevé de terre roumain',
      garmin: garmin('DEADLIFT/ROMANIAN_DEADLIFT'),
      dose: { sets: 3, reps: 8, tempo: '3-1-1', load: 'RPE 7, dos neutre' },
      by_phase: {
        build: { sets: 4, reps: 5, tempo: '3-1-1', load: 'RPE 8 : 2 en réserve' },
        'mont-blanc': { sets: 3, reps: 6, tempo: '3-1-1', load: 'RPE 8' },
      },
      per_side: false,
      rest_s: 120,
      primary: [...HAMSTRINGS, ...both('gluteus_maximus')],
      secondary: both(
        'adductor_magnus',
        'iliocostalis_lumborum',
        'longissimus_thoracis',
        'multifidus_lumborum'
      ),
      cue: 'Hanches en arrière, barre contre les cuisses, genoux souples, stop à mi-tibia.',
      regression: 'Pont fessier au sol, 3 × 12.',
      maison: {
        name: 'Soulevé de terre roumain sur une jambe (sac à dos)',
        garmin: garmin('DEADLIFT/SINGLE_LEG_ROMANIAN_DEADLIFT_WITH_DUMBBELL', 'closest'),
        load: 'Sac à dos de 8–12 kg, sur une jambe, RPE 7',
      },
    },
    {
      id: 'calf_raise_straight',
      name: 'Mollets jambe tendue, lourd et lent',
      garmin: garmin('CALF_RAISE/SINGLE_LEG_STANDING_DUMBBELL_CALF_RAISE'),
      dose: { sets: 3, reps: 12, tempo: '3-0-3', load: 'Haltère 8–12 kg, RPE 7' },
      by_phase: {
        build: { sets: 4, reps: 8, tempo: '3-0-3', load: 'Haltère 16–20 kg, RPE 8' },
      },
      per_side: true,
      rest_s: 90,
      primary: [...GASTROCNEMIUS, ...both('calcaneal_tendon')],
      secondary: both('soleus'),
      cue: 'Sur une marche, talon sous la marche en bas, 3 s pour monter, 3 s pour descendre.',
      regression: 'Deux pieds, sans charge, 3 × 15.',
      maison: {
        name: 'Mollets sur une jambe, sur une marche',
        garmin: garmin('CALF_RAISE/SINGLE_LEG_STANDING_CALF_RAISE'),
        load: 'Poids du corps puis sac à dos, RPE 7',
      },
    },
    {
      id: 'calf_raise_bent',
      name: 'Mollets genou fléchi (soléaire)',
      garmin: garmin('CALF_RAISE/WEIGHTED_SEATED_CALF_RAISE'),
      dose: { sets: 3, reps: 12, tempo: '3-0-3', load: 'Machine assise, RPE 7' },
      by_phase: {
        build: { sets: 3, reps: 10, tempo: '3-0-3', load: 'Machine assise, RPE 8' },
      },
      per_side: false,
      rest_s: 90,
      primary: [...both('soleus'), ...both('calcaneal_tendon')],
      secondary: [...GASTROCNEMIUS, ...both('tibialis_posterior')],
      cue: 'Genoux à 90°, montée et descente en 3 s, amplitude complète.',
      regression: 'Sans charge, genou fléchi debout, 3 × 15.',
      maison: {
        name: 'Mollets genou fléchi sur une jambe',
        garmin: garmin('CALF_RAISE/SINGLE_LEG_BENT_KNEE_CALF_RAISE'),
        load: 'Poids du corps, une jambe puis l’autre, RPE 7',
      },
    },
    {
      id: 'dead_bug',
      name: 'Dead bug',
      garmin: garmin('HIP_STABILITY/DEAD_BUG'),
      dose: { sets: 3, reps: 8, tempo: '2-1-2', load: 'Lombaires plaquées au sol' },
      per_side: true,
      rest_s: 45,
      primary: both('rectus_abdominis', 'transversus_abdominis'),
      secondary: [...OBLIQUES, ...both('iliacus', 'psoas_major')],
      cue: 'Bras et jambe opposés s’allongent ensemble, expire, le bas du dos ne décolle pas.',
      regression: 'Seulement les jambes, genoux fléchis.',
      maison: null,
    },
    {
      id: 'side_plank_abduction',
      name: 'Gainage latéral avec abduction',
      garmin: garmin('PLANK/SIDE_PLANK_WITH_LEG_LIFT'),
      dose: { sets: 3, reps: 10, tempo: '2-1-2', load: 'Poids du corps' },
      by_phase: {
        build: { sets: 3, reps: 12, tempo: '2-1-2', load: 'Lest de cheville 1–2 kg' },
      },
      per_side: true,
      rest_s: 45,
      primary: both('gluteus_medius', 'gluteus_minimus', 'tensor_fasciae_latae'),
      secondary: [...OBLIQUES, ...both('quadratus_lumborum')],
      cue: 'Sur le coude, corps aligné, la jambe du dessus monte tendue, pied parallèle au sol.',
      regression: 'Abduction couché sur le côté, sans gainage.',
      maison: null,
    },
    {
      id: 'copenhagen_plank',
      name: 'Copenhagen plank (progression)',
      garmin: garmin('PLANK/SIDE_PLANK_WITH_FEET_ON_BENCH', 'closest'),
      dose: { sets: 3, seconds: 20, load: 'Levier court : genou sur le banc' },
      by_phase: {
        build: { sets: 3, seconds: 30, load: 'Levier long : cheville sur le banc' },
        'mont-blanc': { sets: 3, seconds: 40, load: 'Levier long, jambe du dessous qui monte' },
      },
      per_side: true,
      rest_s: 60,
      primary: ADDUCTORS,
      secondary: [...OBLIQUES, ...both('pectineus')],
      cue: 'Gainage latéral, la jambe du dessus posée sur un banc tient le corps, la jambe du dessous libre.',
      regression: 'Adducteurs couché : serrer un ballon entre les genoux 5 × 10 s.',
      maison: null,
    },
    {
      id: 'single_leg_bridge',
      name: 'Pont fessier sur une jambe',
      garmin: garmin('HIP_RAISE/SINGLE_LEG_HIP_RAISE'),
      dose: { sets: 3, reps: 12, tempo: '2-1-2', load: 'Poids du corps' },
      by_phase: {
        build: {
          sets: 3,
          reps: 10,
          tempo: '2-1-2',
          load: 'Pied sur un banc, haltère sur la hanche',
        },
      },
      per_side: true,
      rest_s: 60,
      primary: both('gluteus_maximus'),
      secondary: [...both('gluteus_medius'), ...HAMSTRINGS],
      cue: 'Le bassin monte sans tourner, serrer le fessier 1 s en haut.',
      regression: 'Pont sur deux pieds.',
      maison: null,
    },
    {
      id: 'nordic_curl',
      name: 'Nordic curl excentrique (progression)',
      garmin: garmin('LEG_CURL/LEG_CURL', 'closest'),
      dose: { sets: 2, reps: 5, tempo: '4-0-0', load: 'Descente freinée, mains pour finir' },
      by_phase: {
        build: { sets: 3, reps: 6, tempo: '5-0-0', load: 'Descente freinée plus bas' },
      },
      per_side: false,
      rest_s: 120,
      primary: HAMSTRINGS,
      secondary: GASTROCNEMIUS,
      cue: 'À genoux, chevilles tenues, le corps descend droit le plus lentement possible ; remonte avec les mains.',
      regression: 'Pont ischios sur talons (pieds loin), 3 × 10.',
      maison: null,
    },
    {
      id: 'pallof_press',
      name: 'Pallof press',
      garmin: garmin('CHOP/HALF_KNEELING_STABILITY_CHOP', 'closest'),
      dose: { sets: 3, reps: 10, tempo: '1-2-1', load: 'Poulie ou élastique moyen' },
      per_side: true,
      rest_s: 45,
      primary: [...OBLIQUES, ...both('transversus_abdominis')],
      secondary: both('rectus_abdominis', 'quadratus_lumborum'),
      cue: 'Bras tendus devant la poitrine, 2 s, sans laisser le tronc tourner vers la poulie.',
      regression: 'Dead bug.',
      maison: {
        name: 'Pallof press à l’élastique',
        garmin: garmin('CHOP/HALF_KNEELING_STABILITY_CHOP', 'closest'),
        load: 'Élastique accroché à une poignée de porte',
      },
    },
    {
      id: 'pogo_hops',
      name: 'Pogo hops (pliométrie, petit volume)',
      garmin: garmin('CARDIO/JUMP_ROPE', 'closest'),
      dose: { sets: 3, seconds: 20, load: '~60 contacts, chevilles raides, contacts brefs' },
      by_phase: {
        build: { sets: 3, seconds: 20, load: '~60 contacts, chevilles raides, contacts brefs' },
        'mont-blanc': { sets: 3, seconds: 20, load: '~60 contacts, puis sauts latéraux' },
      },
      per_side: false,
      rest_s: 60,
      primary: [...both('soleus', 'calcaneal_tendon'), ...GASTROCNEMIUS],
      secondary: [...both('rectus_femoris', 'vastus_medialis', 'patellar_ligament')],
      phases: ['build', 'mont-blanc'],
      cue: 'Petits sauts sur place, genoux presque tendus, le moins de temps possible au sol.',
      regression: 'Pas de saut : mollets lents à la place, tant que le genou n’est pas calme.',
      maison: null,
    },
  ],
}

// --- Reading it

// The phase `day` falls in, null outside every phase (a recovery week)
export const phaseOn = (phases: ReadonlyArray<Phase>, day: string): Phase | null =>
  phases.find((phase) => phase.from <= day && day <= phase.to) ?? null

export type Variant = 'gym' | 'maison'

// One exercise as a session asks it that day: its dose for the phase, its sets scaled by the
// phase's volume, the home variant's name, key and load when at home
export interface Prescribed {
  readonly id: string
  readonly name: string
  readonly garmin: GarminKey
  // The programme's own name when the variant replaces it, else null
  readonly instead_of: string | null
  readonly sets: number
  readonly reps: number | null
  readonly seconds: number | null
  readonly per_side: boolean
  readonly tempo: string | null
  readonly load: string
  readonly rest_s: number
  readonly cue: string
  readonly regression: string
  readonly primary: ReadonlyArray<string>
  readonly secondary: ReadonlyArray<string>
}

export interface SessionPlan {
  readonly session: Session
  readonly phase: Phase
  readonly variant: Variant
  readonly exercises: ReadonlyArray<Prescribed>
}

// An exercise's dose for a phase: its own for that phase, else the base one
const doseFor = (exercise: Exercise, phase: Phase): Dose =>
  phase.doses === 'base' ? exercise.dose : (exercise.by_phase?.[phase.doses] ?? exercise.dose)

const prescribe = (exercise: Exercise, phase: Phase, variant: Variant): Prescribed => {
  const dose = doseFor(exercise, phase)
  const home = variant === 'maison' ? exercise.maison : null
  return {
    id: exercise.id,
    name: home?.name ?? exercise.name,
    garmin: home?.garmin ?? exercise.garmin,
    instead_of: home === null ? null : exercise.name,
    sets: Math.max(1, Math.round(dose.sets * phase.volume)),
    reps: dose.reps ?? null,
    seconds: dose.seconds ?? null,
    per_side: exercise.per_side,
    tempo: dose.tempo ?? null,
    load: home?.load ?? dose.load,
    rest_s: exercise.rest_s,
    cue: exercise.cue,
    regression: exercise.regression,
    primary: exercise.primary,
    secondary: exercise.secondary,
  }
}

// Session `id` as asked on `day`: null when no phase covers the day or the session is unknown
export const sessionPlan = (
  program: StrengthProgram,
  id: string,
  day: string,
  variant: Variant
): SessionPlan | null => {
  const phase = phaseOn(program.phases, day)
  const session = program.sessions.find((candidate) => candidate.id === id)
  if (phase === null || session === undefined) return null
  const exercises = session.exercises.flatMap((exerciseId) => {
    const exercise = program.exercises.find((candidate) => candidate.id === exerciseId)
    if (exercise === undefined) return []
    if (exercise.phases !== undefined && !exercise.phases.includes(phase.kind)) return []
    return [prescribe(exercise, phase, variant)]
  })
  return { session, phase, variant, exercises }
}

// The session after `last` in the programme's order (the first after none): A, B, A…
export const nextSession = (program: StrengthProgram, last: string | null): string => {
  const ids = program.sessions.map((session) => session.id)
  const at = last === null ? -1 : ids.indexOf(last)
  return ids[(at + 1) % ids.length] ?? ids[0] ?? 'A'
}
