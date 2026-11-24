import { join } from 'node:path'

import { and, asc, between, isNotNull, sql } from 'drizzle-orm'
import { Config, Context, Effect, FileSystem, Layer, Schema, Semaphore } from 'effect'

import { Anatomy, readableCatalog } from '../anatomy/anatomy.ts'
import { type Catalog, closestIds, structureLabel, structureOf } from '../anatomy/catalog.ts'
import { addDays, parisToday } from '../days.ts'
import { Database, type DatabaseError } from '../db.ts'
import { writeAtomic } from '../files.ts'
import { EXERCISES, type WorkoutInput } from '../garmin/workout-builder.ts'
import { type BodyNote, type BodyPin, bodyHistory } from '../journal/history.ts'
import { dayType, type DoneSession, type PlannedSession } from '../nutrition/day-type.ts'
import { sessionsOn } from '../nutrition/nutrition.ts'
import { journal } from '../schema.ts'

import {
  type LastSession,
  lastSession,
  type Progression,
  progressions,
  sessionIdOf,
  type SetRow,
  type StrengthActivity,
  type WeekCount,
  weeklyCounts,
} from './history.ts'
import { type PainFlag, painFlags, type RecentPain, worstPains, workedStructures } from './pain.ts'
import {
  DEFAULT_PROGRAM,
  nextSession,
  type Phase,
  phaseOn,
  PROGRAM_PATH,
  type SessionPlan,
  sessionPlan,
  type StrengthProgram,
  StrengthProgramJson,
  type Variant,
} from './program.ts'
import { mondayOf, placeSessions, type WeekDay, type WeekPlacement } from './schedule.ts'
import { strengthWorkout } from './workout.ts'

// The Renfo page's and the coach's answer: the programme (its file in data/, read on each request,
// never in SQLite), the week's sessions placed around the runs of the calendar and the runs done,
// the sessions done (strength_sets), the pains of the journal against what the week loads.

export const HISTORY_WEEKS = 12

export interface ProposedSession {
  readonly day: string
  // The programme's session: A, B…
  readonly session: string
  readonly reason: string
  readonly warning: string | null
  readonly plan: SessionPlan
  readonly pain: ReadonlyArray<PainFlag>
  // create_workout's input, for the watch
  readonly workout: WorkoutInput
}

export interface WeekProposal {
  readonly week: string
  readonly variant: Variant
  readonly placement: WeekPlacement
  readonly sessions: ReadonlyArray<ProposedSession>
}

export interface StrengthHistory {
  readonly target: number
  readonly weeks: ReadonlyArray<WeekCount>
  readonly total: number
  readonly progressions: ReadonlyArray<Progression>
  readonly last: LastSession | null
}

// A strength workout of the calendar, from today on
export interface PlannedStrength {
  readonly day: string
  readonly name: string
  readonly session: string | null
}

export interface NextSession {
  readonly day: string
  readonly title: string
  readonly from: 'calendar' | 'proposal'
  readonly session: string | null
}

export interface PainView {
  readonly structure: string
  readonly label: string
  readonly pain: number
  readonly day: string
}

export interface StrengthView {
  readonly today: string
  readonly variant: Variant
  readonly program: StrengthProgram
  readonly saved: boolean
  readonly phase: Phase | null
  // Each session as the current phase asks it (the next phase's in a recovery week)
  readonly plans: ReadonlyArray<SessionPlan>
  readonly weeks: readonly [WeekProposal, WeekProposal]
  readonly calendar: ReadonlyArray<PlannedStrength>
  readonly next: NextSession | null
  readonly history: StrengthHistory
  // The window's worst pain per structure, the worst first
  readonly pains: ReadonlyArray<PainView>
  // The window's pains as the body map pins them
  readonly pins: ReadonlyArray<BodyPin>
  // The pain rule against the week's sessions (both sessions when none is placed)
  readonly flags: ReadonlyArray<PainFlag>
  // What the week's sessions load
  readonly worked: ReadonlyArray<{
    readonly structure: string
    readonly role: 'primary' | 'secondary'
  }>
  // French names of the structures above, for the lists
  readonly labels: Readonly<Record<string, string>>
}

// What the home page shows of today's strength session: the calendar's, else the proposal's
export interface StrengthToday {
  readonly from: 'calendar' | 'proposal'
  readonly title: string
  readonly exercises: ReadonlyArray<string>
  readonly flags: number
}

// A structure in French when the catalog knows it, else its id
export const labelFrom =
  (catalog: Catalog | null) =>
  (id: string): string => {
    const structure = structureOf(catalog, id)
    return structure === undefined ? id : structureLabel(structure.french, structure.side)
  }

// A sport's family: every run one (a treadmill run replaces the run planned)
const familyOf = (sport: string | null) =>
  sport !== null && /running/u.test(sport) ? 'running' : sport

// A day as the scheduler reads it: its runs (and other sessions) judged by day-type.ts, the
// calendar's entries still to do (one a session done has replaced is done), a strength session
// done or planned
export const weekDayOf = (
  day: string,
  done: ReadonlyArray<DoneSession>,
  planned: ReadonlyArray<PlannedSession>,
  z4FloorBpm: number | null
): WeekDay => {
  const judged = dayType(
    done.filter((session) => session.sport !== STRENGTH),
    planned.filter((session) => session.sport !== STRENGTH),
    z4FloorBpm
  )
  const doneFamilies = new Set(done.map((session) => familyOf(session.sport)))
  return {
    day,
    type: judged.type,
    reason: judged.reason,
    calendar: planned
      .filter((session) => !doneFamilies.has(familyOf(session.sport)))
      .map((session) => session.name),
    strength: [...done, ...planned].some((session) => session.sport === STRENGTH),
  }
}

// The pains of the pinned notes
const painsOf = (notes: ReadonlyArray<BodyNote>): Array<RecentPain> =>
  notes.map((note) => ({ structure: note.body.structure, day: note.day, pain: note.body.pain }))

// The pain rule's line on the watch: "Règle des 3/10 (droit fémoral, côté droit 3/10) : …"
const painNote = (flag: PainFlag, labelOf: (id: string) => string) => {
  const [worst] = flag.structures
  return `Règle des 3/10${worst === undefined ? '' : ` (${labelOf(worst.structure)} ${worst.pain}/10)`} : ${flag.exercise} → ${flag.regression}`
}

// The week's proposal from what was read: the placement, a session each slot in the programme's
// order after `lastBefore` (the last session named before a day), its plan, the pain rule, the
// workout for the watch. A slot on a day no phase covers is left out (a recovery week).
export const proposeWeek = (input: {
  readonly program: StrengthProgram
  readonly week: string
  readonly today: string
  readonly variant: Variant
  readonly days: ReadonlyArray<WeekDay>
  readonly lastBefore: (day: string) => string | null
  readonly pains: ReadonlyArray<RecentPain>
  readonly labelOf: (id: string) => string
}): WeekProposal => {
  const { program, week, variant } = input
  const placement = placeSessions({
    week,
    today: input.today,
    days: input.days,
    target: program.sessions_per_week,
    minDaysApart: Math.ceil(program.min_hours_apart / 24),
  })
  let last: string | null = null
  const sessions = placement.slots.flatMap((slot, index): Array<ProposedSession> => {
    const session = nextSession(program, index === 0 ? input.lastBefore(slot.day) : last)
    last = session
    const plan = sessionPlan(program, session, slot.day, variant)
    if (plan === null) return []
    const pain = painFlags(plan.exercises, input.pains, program.pain_rule.threshold)
    return [
      {
        day: slot.day,
        session,
        reason: slot.reason,
        warning: slot.warning,
        plan,
        pain,
        workout: strengthWorkout(
          plan,
          slot.day,
          pain.map((flag) => painNote(flag, input.labelOf))
        ),
      },
    ]
  })
  return { week, variant, placement, sessions }
}

// The next session: the calendar's first from today, else the proposal's first slot from today
export const nextOf = (
  calendar: ReadonlyArray<PlannedStrength>,
  slot: Pick<ProposedSession, 'day' | 'session' | 'workout'> | undefined
): NextSession | null => {
  const [planned] = calendar
  if (planned !== undefined) {
    return { day: planned.day, title: planned.name, from: 'calendar', session: planned.session }
  }
  return slot === undefined
    ? null
    : { day: slot.day, title: slot.workout.name, from: 'proposal', session: slot.session }
}

// Why a programme cannot be saved against the anatomy model's catalog, or null: an unknown
// structure, with the nearest ids
export const unknownStructures = (program: StrengthProgram, catalog: Catalog | null) => {
  if (catalog === null) return null
  const unknown = program.exercises.flatMap((exercise) =>
    [...exercise.primary, ...exercise.secondary]
      .filter((id) => structureOf(catalog, id) === undefined)
      .map((id) => {
        const close = closestIds(catalog, id, id.endsWith('_l') ? 'left' : 'right')
        return `${exercise.id} : ${id} inconnu${close.length === 0 ? '' : ` (proches : ${close.join(', ')})`}`
      })
  )
  return unknown.length === 0 ? null : unknown.join(' ; ')
}

// The programme's file cannot be read or written (its message says why)
export class StrengthError extends Schema.TaggedError<StrengthError>()('StrengthError', {
  message: Schema.String,
}) {}

const decodeProgram = Schema.decodeUnknownEffect(Schema.fromJsonString(StrengthProgramJson))

const STRENGTH = 'strength_training'

export class Strength extends Context.Service<
  Strength,
  {
    // The programme's file, the programme of 2026-11-24 without one; saved: whether the file exists
    readonly program: Effect.Effect<
      { readonly program: StrengthProgram; readonly saved: boolean },
      StrengthError
    >
    readonly setProgram: (program: StrengthProgram) => Effect.Effect<StrengthProgram, StrengthError>
    // The week of `day` (any of its days), placed and prescribed
    readonly week: (
      day: string,
      variant: Variant
    ) => Effect.Effect<WeekProposal, StrengthError | DatabaseError>
    readonly history: (
      weeks: number
    ) => Effect.Effect<StrengthHistory, StrengthError | DatabaseError>
    readonly view: (variant: Variant) => Effect.Effect<StrengthView, StrengthError | DatabaseError>
    readonly today: Effect.Effect<StrengthToday | null, StrengthError | DatabaseError>
  }
>()('garmin/Strength') {
  static readonly layer = Layer.effect(
    Strength,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const database = yield* Database
      const anatomy = yield* Anatomy
      const path = join(yield* Config.String('DATA_DIR'), PROGRAM_PATH)
      const lock = yield* Semaphore.make(1)
      const all = <A extends object>(query: ReturnType<typeof sql>) =>
        database.use((db) => db.all<A>(query))

      const broken = (why: string) => new StrengthError({ message: `${PROGRAM_PATH} : ${why}` })

      const program = fs.readFileString(path).pipe(
        Effect.flatMap((text) =>
          Effect.mapError(decodeProgram(text), (error) => broken(error.message))
        ),
        Effect.map((read) => ({ program: read, saved: true })),
        Effect.catchTag('PlatformError', (error) =>
          error.reason._tag === 'NotFound'
            ? Effect.succeed({ program: DEFAULT_PROGRAM, saved: false })
            : Effect.fail(broken(error.message))
        )
      )

      const setProgram = Effect.fn('Strength.setProgram')(function* (next: StrengthProgram) {
        const unknown = unknownStructures(next, yield* readableCatalog(anatomy))
        if (unknown !== null) return yield* new StrengthError({ message: unknown })
        yield* lock
          .withPermits(1)(writeAtomic(fs, path, `${JSON.stringify(next, null, 2)}\n`))
          .pipe(Effect.mapError((error) => broken(error.message)))
        return next
      })

      // hr_zone_bounds holds each zone's top bound: zone 3's is zone 4's floor
      const z4Floor = Effect.map(
        all<{ floor: number | null }>(sql`
          SELECT json_extract(hr_zone_bounds, '$[3]') AS floor FROM activities
          WHERE sport LIKE '%running%' AND hr_zone_bounds IS NOT NULL
          ORDER BY start_time DESC LIMIT 1`),
        ([row]) => row?.floor ?? null
      )

      const weekDay = Effect.fnUntraced(function* (day: string, floor: number | null) {
        const { done, planned } = yield* sessionsOn(day).pipe(
          Effect.provideService(Database, database)
        )
        return weekDayOf(day, done, planned, floor)
      })

      // Every strength session named in the activities and the calendar, newest first
      const namedSessions = Effect.map(
        all<{ day: string; name: string | null; workout_name: string | null }>(sql`
          SELECT day, name, workout_name FROM activities WHERE sport = ${STRENGTH}
          UNION ALL
          SELECT day, name, NULL FROM planned_workouts WHERE sport = ${STRENGTH}
          ORDER BY day DESC`),
        (rows) =>
          rows.flatMap((row) => {
            const id = sessionIdOf(row)
            return id === null ? [] : [{ day: row.day, id }]
          })
      )

      // The pains pinned on the body map in the pain rule's window, in day order
      const painNotes = (today: string, days: number) =>
        database.use((db) =>
          db
            .select({
              time: journal.time,
              day: journal.day,
              text: journal.text,
              body: journal.body,
            })
            .from(journal)
            .where(
              and(isNotNull(journal.body), between(journal.day, addDays(today, -(days - 1)), today))
            )
            .orderBy(asc(journal.day), asc(journal.time))
            .all()
            .flatMap(({ body, ...note }): Array<BodyNote> =>
              body === null ? [] : [{ ...note, body }]
            )
        )
      const recentPains = (today: string, days: number) =>
        Effect.map(painNotes(today, days), painsOf)

      const proposal = Effect.fnUntraced(function* (input: {
        readonly program: StrengthProgram
        readonly today: string
        readonly day: string
        readonly variant: Variant
        readonly pains: ReadonlyArray<RecentPain>
        readonly labelOf: (id: string) => string
      }) {
        const week = mondayOf(input.day)
        const floor = yield* z4Floor
        const days = yield* Effect.forEach(
          Array.from({ length: 9 }, (_, index) => addDays(week, index - 1)),
          (day) => weekDay(day, floor)
        )
        const named = yield* namedSessions
        return proposeWeek({
          ...input,
          week,
          days,
          lastBefore: (day) => named.find((session) => session.day < day)?.id ?? null,
        })
      })

      const week = Effect.fn('Strength.week')(function* (day: string, variant: Variant) {
        const today = yield* parisToday
        const current = (yield* program).program
        const catalog = yield* readableCatalog(anatomy)
        return yield* proposal({
          program: current,
          today,
          day,
          variant,
          pains: yield* recentPains(today, current.pain_rule.days),
          labelOf: labelFrom(catalog),
        })
      })

      // A catalog key's name: the programme's French one, else Garmin's catalog's
      const namer = (current: StrengthProgram) => {
        const names = new Map<string, string>()
        for (const entry of EXERCISES) names.set(`${entry.category}/${entry.exercise}`, entry.name)
        for (const exercise of current.exercises) {
          if (exercise.maison !== null) {
            const { category, exercise_name } = exercise.maison.garmin
            names.set(`${category}/${exercise_name}`, exercise.maison.name)
          }
          if (exercise.garmin.match === 'exact') {
            names.set(`${exercise.garmin.category}/${exercise.garmin.exercise_name}`, exercise.name)
          }
        }
        return (key: string) => names.get(key) ?? key
      }

      const historyOf = Effect.fnUntraced(function* (
        current: StrengthProgram,
        today: string,
        weeks: number
      ) {
        const activities = yield* all<StrengthActivity>(sql`
          SELECT id, day, name, workout_name,
            coalesce(CASE WHEN moving_s > 0 THEN moving_s END, elapsed_s) / 60.0 AS minutes
          FROM activities WHERE sport = ${STRENGTH} ORDER BY day, id`)
        const sets = yield* all<SetRow>(sql`
          SELECT s.activity_id, s.idx, s.category, s.exercise_name, s.reps, s.weight_kg,
            s.duration_s
          FROM strength_sets s JOIN activities a ON a.id = s.activity_id
          WHERE a.sport = ${STRENGTH} ORDER BY s.activity_id, s.idx`)
        const nameOf = namer(current)
        const keys = current.exercises.map(
          (exercise) => `${exercise.garmin.category}/${exercise.garmin.exercise_name}`
        )
        return {
          target: current.sessions_per_week,
          weeks: weeklyCounts(
            activities.map((activity) => activity.day),
            today,
            weeks
          ),
          total: activities.length,
          progressions: progressions(sets, activities, keys, nameOf),
          last: lastSession(sets, activities, nameOf),
        } satisfies StrengthHistory
      })

      const history = Effect.fn('Strength.history')(function* (weeks: number) {
        return yield* historyOf((yield* program).program, yield* parisToday, weeks)
      })

      const calendarFrom = (today: string) =>
        Effect.map(
          all<{ day: string; name: string }>(sql`
            SELECT day, name FROM planned_workouts
            WHERE sport = ${STRENGTH} AND day >= ${today} ORDER BY day, id`),
          (rows) =>
            rows.map((row) => ({
              ...row,
              session: sessionIdOf({ name: row.name, workout_name: null }),
            }))
        )

      const view = Effect.fn('Strength.view')(function* (variant: Variant) {
        const today = yield* parisToday
        const read = yield* program
        const current = read.program
        const catalog = yield* readableCatalog(anatomy)
        const labelOf = labelFrom(catalog)
        const notes = yield* painNotes(today, current.pain_rule.days)
        const pains = painsOf(notes)
        const pinned = bodyHistory(
          { from: addDays(today, -(current.pain_rule.days - 1)), to: today },
          notes,
          catalog
        )
        const propose = (day: string) =>
          proposal({ program: current, today, day, variant, pains, labelOf })
        const weeks = [yield* propose(today), yield* propose(addDays(mondayOf(today), 7))] as const
        const calendar = yield* calendarFrom(today)
        const slot = weeks.flatMap((proposed) => proposed.sessions).find((s) => s.day >= today)
        // The week's exercises; both sessions when the week places none
        const sessionsOfWeek = weeks[0].sessions.length > 0 ? weeks[0].sessions : weeks[1].sessions
        const exercises =
          sessionsOfWeek.length > 0
            ? sessionsOfWeek.flatMap((session) => session.plan.exercises)
            : current.sessions.flatMap(
                (session) => sessionPlan(current, session.id, today, variant)?.exercises ?? []
              )
        const flags = painFlags(
          [...new Map(exercises.map((exercise) => [exercise.id, exercise])).values()],
          pains,
          current.pain_rule.threshold
        )
        const worked = [...workedStructures(exercises)].map(([structure, role]) => ({
          structure,
          role,
        }))
        const worst = [...worstPains(pains).values()].toSorted(
          (a, b) => b.pain - a.pain || b.day.localeCompare(a.day)
        )
        const shownDay =
          phaseOn(current.phases, today) === null
            ? (current.phases.find((phase) => phase.from > today)?.from ?? today)
            : today
        const plans = current.sessions.flatMap(
          (session) => sessionPlan(current, session.id, shownDay, variant) ?? []
        )
        const labels = Object.fromEntries(
          [
            ...new Set([
              ...current.exercises.flatMap((exercise) => [
                ...exercise.primary,
                ...exercise.secondary,
              ]),
              ...worst.map((p) => p.structure),
            ]),
          ].map((id) => [id, labelOf(id)])
        )
        return {
          today,
          variant,
          program: current,
          saved: read.saved,
          phase: phaseOn(current.phases, today),
          plans,
          weeks,
          calendar,
          next: nextOf(calendar, slot),
          history: yield* historyOf(current, today, HISTORY_WEEKS),
          pains: worst.map((pain) => ({ ...pain, label: labelOf(pain.structure) })),
          pins: pinned.pins,
          flags,
          worked,
          labels,
        } satisfies StrengthView
      })

      const today = Effect.gen(function* () {
        const day = yield* parisToday
        const [planned] = (yield* calendarFrom(day)).filter((entry) => entry.day === day)
        const current = (yield* program).program
        const pains = yield* recentPains(day, current.pain_rule.days)
        if (planned !== undefined) {
          const plan =
            planned.session === null ? null : sessionPlan(current, planned.session, day, 'gym')
          return {
            from: 'calendar',
            title: planned.name,
            exercises: plan?.exercises.map((exercise) => exercise.name) ?? [],
            flags:
              plan === null
                ? 0
                : painFlags(plan.exercises, pains, current.pain_rule.threshold).length,
          } satisfies StrengthToday
        }
        const proposed = (yield* proposal({
          program: current,
          today: day,
          day,
          variant: 'gym',
          pains,
          labelOf: labelFrom(null),
        })).sessions.find((session) => session.day === day)
        return proposed === undefined
          ? null
          : ({
              from: 'proposal',
              title: proposed.workout.name,
              exercises: proposed.plan.exercises.map((exercise) => exercise.name),
              flags: proposed.pain.length,
            } satisfies StrengthToday)
      })

      return Strength.of({ program, setProgram, week, history, view, today })
    })
  )
}

// For the MCP: a proposal without the plans' internals, its workouts as the watch will show them
export const proposalOf = (proposal: WeekProposal) => ({
  week: proposal.week,
  variant: proposal.variant,
  already: proposal.placement.already,
  missing: proposal.placement.missing,
  rejected: proposal.placement.rejected,
  sessions: proposal.sessions.map((session) => ({
    day: session.day,
    session: session.session,
    phase: session.plan.phase.label,
    reason: session.reason,
    warning: session.warning,
    pain_rule: session.pain,
    workout_name: session.workout.name,
    exercises: session.plan.exercises.map((exercise) => ({
      id: exercise.id,
      name: exercise.name,
      sets: exercise.sets,
      reps: exercise.reps,
      seconds: exercise.seconds,
      per_side: exercise.per_side,
      tempo: exercise.tempo,
      load: exercise.load,
      garmin: exercise.garmin,
    })),
  })),
})

export type ProposalAnswer = ReturnType<typeof proposalOf>
