import { ORPCError } from '@orpc/server'
import { Effect, Option, Schema } from 'effect'

import { Anatomy, readableCatalog } from '../anatomy/anatomy.ts'
import { Caffeine } from '../caffeine/caffeine.ts'
import {
  ClockSchema,
  DRINK_KINDS,
  DRINKS,
  CaffeineIntakeJson,
  InstantSchema,
  Mg,
} from '../caffeine/intake.ts'
import {
  BEDTIME_LEFT_MG,
  DAY_LIMIT_MG,
  DOSE_LIMIT_MG,
  HALF_LIFE_H,
  RULE_HOURS,
  STANDARD_COFFEE_MG,
  TARGET_BEDTIME,
} from '../caffeine/kinetics.ts'
import { HIGH_MG, MIN_NIGHTS } from '../caffeine/sleep.ts'
import { addDays, parisToday } from '../days.ts'
import { GarminLogin } from '../garmin/login.ts'
import { buildWorkout, findExercises, WorkoutSchema } from '../garmin/workout-builder.ts'
import { GarminWorkouts } from '../garmin/workouts.ts'
import { bodyHistory } from '../journal/history.ts'
import { Journal } from '../journal/log.ts'
import { JournalNoteJson, NoteBodyJson } from '../journal/note.ts'
import { Nutrition, todayOf } from '../nutrition/nutrition.ts'
import { NutritionPlanJson } from '../nutrition/plan.ts'
import { CAUTIONS, SupplementsJson, UPPER_LIMITS } from '../nutrition/supplements.ts'
import { FactsInputSchema, MAX_GPX_BYTES, PlanInputSchema, SlugSchema } from '../races/race.ts'
import { Races } from '../races/races.ts'
import { MAX_ROWS, Reader } from '../reader.ts'
import { Stats } from '../stats.ts'
import { StrengthProgramJson } from '../strength/program.ts'
import { mondayOf } from '../strength/schedule.ts'
import { proposalOf, Strength, StrengthError } from '../strength/strength.ts'
import { Tools } from '../tools.ts'
import { withingsStatus } from '../withings/sync.ts'

import { Day, standard, tool } from './base.ts'
import { SLEEP_PERIODS } from './periods.ts'

// The Garmin data and the watch's workouts: each procedure an MCP tool (its name), an OpenAPI
// operation (under /api) and an RPC call (under /rpc). The tools' names and inputs are the MCP's.

const DATA_MODEL = `Data: the user's Garmin history (watch, scale): every activity from its FIT file (laps, per-second samples) and Garmin Connect's summary, plus daily wellness (sleep, HRV, resting HR, body battery, readiness), weigh-ins and the Garmin calendar's planned workouts. Synced from Garmin Connect every 3 hours (sync_status tells when). The SQL is read-only; the workout tools (create_workout, schedule_workout, unschedule_workout, delete_workout) write to the Garmin calendar and refresh planned_workouts right after; log_note adds a note to the user's journal, body_history reads the pains pinned on the web app's 3D body map; add_race and plan_race write the user's target races and their plans; set_nutrition_plan writes the nutrition plan agreed with the user; set_supplements writes the supplements the user takes; set_strength_program writes the strength programme, schedule_strength places a week's strength sessions and pushes them to the Garmin calendar; sleep_insights analyses the nights (bedtime and duration against recovery, the window they point to, tonight's advice).
Conventions: timestamps ISO 8601 UTC text, start_local local wall time, day YYYY-MM-DD (local). Metres, seconds, m/s, bpm, kg. Cadence is steps/min on foot, rpm on a bike.
Tables and views:
- activities: one row per Garmin Connect activity (id = its activity id). sport (Connect's type: running, trail_running, cycling, lap_swimming, hiking, strength_training…), name, start_time, start_local, day, elapsed_s, moving_s, distance_m, ascent_m, descent_m, avg_hr, max_hr, avg_speed, max_speed, avg_cadence, max_cadence, avg_power, max_power, norm_power, calories, training_load (Garmin's EPOC load), aerobic_te / anaerobic_te (training effect 0-5), te_label (TEMPO, BASE…), vo2max, rpe (0-10) and feel (0-100) entered after it, hr_z1_s…hr_z5_s (seconds in the watch's HR zones), hr_zone_bounds (JSON: the zones' top bounds [z0, z1…z5]), workout_name (the structured workout run, as in planned_workouts.name), gear, device, start_lat/start_lon, polyline (Google encoded, precision 5).
- activity_summary (view): the same in Connect's units: distance_km, moving_min, pace_min_km (m:ss, on foot), speed_kmh, z1_min…z5_min. Use it to list activities.
- laps: activity_id, idx (0-based), start_time, elapsed_s, moving_s, distance_m, avg_hr, max_hr, avg_speed, max_speed, avg_cadence, avg_power, ascent_m, descent_m, intensity (active, rest, warmup, cooldown), trigger (manual, distance…), workout_step.
- samples: per second: activity_id, t (seconds from start), lat, lon, alt, hr, speed, cadence, power, distance (cumulative m). Large: always filter by activity_id.
- daily: one row per day. Sleep is the night ending that morning: sleep_start, sleep_end, sleep_s, deep_s, light_s, rem_s, awake_s, nap_s, sleep_score; hrv (overnight average, ms), hrv_weekly, hrv_status (BALANCED, UNBALANCED, LOW…), hrv_baseline_low/high; resting_hr, min_hr, max_hr; body_battery_high/low/wake/charged/drained; steps, distance_m, active_kcal, total_kcal; stress_avg, stress_max; intensity_moderate_min, intensity_vigorous_min; respiration_avg, spo2_avg; readiness (the morning's training readiness 0-100), readiness_level, readiness_feedback, recovery_time_h (Garmin's recovery time left, hours), acute_load (Garmin's 7-day acute load); chronic_load, training_status; vo2max / vo2max_cycling (only on days measured); race_5k_s, race_10k_s, race_half_s, race_marathon_s (Garmin's predictions).
- weekly (view): per ISO week (week = Monday) and sport: activities, distance_km, moving_h, ascent_m, training_load, longest_km, z4_z5_min.
- body: weigh-ins: time, day, weight_kg, bmi, body_fat_pct, body_water_pct, muscle_mass_kg, bone_mass_kg, visceral_fat, source ('WITHINGS' for the Withings scale, synced on its own every 3 hours; else Garmin's source type, e.g. INDEX_SCALE, MANUAL).
- planned_workouts: the Garmin calendar's scheduled workouts: id (the calendar entry: unschedule_workout's schedule_id), day, workout_id (the library's workout: schedule_workout, delete_workout), name, sport, description, estimated_duration_s, estimated_distance_m, steps (one readable line per step: "interval 3:00 HR 165-172", "5× [...]").
- journal: the user's notes (log_note): time (the instant written, its key), day (the day it is about), text, body (JSON, NULL unless the note is a pain pinned on the body map: structure (the anatomy model's id, e.g. vastus_lateralis_r), side, point [x, y, z] (metres on the model, Y up, origin between the feet, right side at -x), pain 0-10, kind, when (array), since; read it with json_extract(body, '$.pain'), body_history names the structures); one file each in data/journal/.
- caffeine: what the user drank (log_caffeine; delete_caffeine removes a mistake): time (the instant drunk, its key), day (Paris), kind (espresso, double_espresso, filter, capsule, cappuccino, black_tea, green_tea, cola, red_bull, monster, custom), mg, note; one file each in data/caffeine/. caffeine_today and caffeine_vs_sleep estimate what is left in the body.
- races are not in SQL: list_races, get_race (files in data/races/: <slug>.gpx, <slug>.json, <slug>.plan.json).
- the nutrition plan is not in SQL: nutrition_plan, and nutrition_today for today's target and the weight trend against it (file data/nutrition/plan.json).
- strength_sets: a strength session's active sets, in order: activity_id (activities.sport = 'strength_training'), idx, start_time, category and exercise_name (Garmin's catalog keys, find_exercises: LUNGE / DUMBBELL_BULGARIAN_SPLIT_SQUAT; NULL when the watch did not know it), reps, weight_kg, duration_s, source ('connect': Garmin Connect's exercise sets, as corrected there; else 'fit': the watch's). strength_history aggregates them.
- the strength programme is not in SQL: strength_program (file data/strength/program.json).
- the supplements are not in SQL: supplements (file data/nutrition/supplements.json); nutrition_today says what to take today and each nutrient's daily average against its upper limit.
- raw_files: the source files ingested (path, error).
- sync_runs: each sync with Garmin Connect: started_at, finished_at, ok, logged_out, account, since, files_written, warnings (JSON), error.`

const QUERY_GUIDE = `SQLite tips:
- Runs of the last 30 days: SELECT * FROM activity_summary WHERE sport LIKE '%running%' AND day >= date('now', '-30 days') ORDER BY day DESC
- Weekly running km: SELECT week, distance_km FROM weekly WHERE sport = 'running' ORDER BY week DESC
- One run's km at a glance: SELECT CAST(distance / 1000 AS INT) AS km, min(t), max(t), avg(hr) FROM samples WHERE activity_id = ? GROUP BY 1
- Pace from a speed: 1000 / speed seconds per km. Dates: date(), strftime('%Y-%W', day), julianday().
- One statement per call. Results are capped at ${MAX_ROWS} rows: aggregate instead of listing samples.`

const WATCH =
  "It changes the user's real Garmin Connect account: the watch gets it at its next sync with the Garmin Connect app."

// The reader keeps MAX_ROWS rows and counts them all: the caller hears what it did not get
export const capRows = ({
  rows,
  total,
}: {
  readonly rows: ReadonlyArray<Record<string, unknown>>
  readonly total: number
}) =>
  total > rows.length
    ? { rows, note: `Truncated to ${rows.length} of ${total} rows. Aggregate or add a LIMIT.` }
    : { rows }

const Id = Schema.Int.check(Schema.isGreaterThan(0))
const opt = Schema.optionalKey

// --- The data (read-only)

const listActivities = tool({
  name: 'list_activities',
  title: 'List activities',
  description:
    'List activities, newest first: day, sport, name, distance, moving time, pace, HR, ascent, cadence, training load, training effect, minutes per HR zone, workout name.',
  method: 'GET',
  path: '/activities',
  tags: ['activities'],
  readOnly: true,
  openWorld: false,
})
  .input(
    standard(
      Schema.Struct({
        from: opt(Day),
        to: opt(Day),
        sport: opt(
          Schema.String.annotate({
            description: 'Part of the sport key, e.g. running, cycling, climbing',
          })
        ),
        limit: opt(Schema.Int.annotate({ description: 'Default 30, at most 500' })),
      })
    )
  )
  .handler(({ input, context }) => context.run(Tools.use((tools) => tools.listActivities(input))))

const getActivity = tool({
  name: 'get_activity',
  title: 'Get an activity',
  description:
    "One activity in full: its summary, laps (pace, HR, cadence, climb, intensity, workout step), splits per km from the samples, HR zones and their bounds, aerobic decoupling (Pa:HR drift, %, under 5 = steady aerobic effort), the route's encoded polyline. samples: 'minute' adds a per-minute series (HR, pace, cadence, altitude, power).",
  method: 'GET',
  path: '/activities/{id}',
  tags: ['activities'],
  readOnly: true,
  openWorld: false,
})
  .input(
    standard(
      Schema.Struct({
        id: Id.annotate({ description: 'The activity id (list_activities)' }),
        samples: opt(Schema.Literals(['none', 'minute'])),
      })
    )
  )
  .handler(async ({ input, context }) => {
    const activity = await context.run(Tools.use((tools) => tools.getActivity(input)))
    if (activity === null) throw new ORPCError('NOT_FOUND', { message: `No activity ${input.id}.` })
    return activity
  })

const compareRuns = tool({
  name: 'compare_runs',
  title: 'Compare runs',
  description:
    'Compare activities side by side (typically runs): pace, HR, cadence, climb, load, minutes per HR zone, efficiency (metres per minute per heartbeat: higher is fitter at the same effort), aerobic decoupling (%) and splits per km.',
  method: 'POST',
  path: '/activities/compare',
  tags: ['activities'],
  readOnly: true,
  openWorld: false,
})
  .input(
    standard(
      Schema.Struct({ ids: Schema.Array(Id).annotate({ description: 'Activity ids, 1 to 10' }) })
    )
  )
  .handler(({ input, context }) => {
    if (input.ids.length === 0 || input.ids.length > 10) {
      throw new ORPCError('BAD_REQUEST', { message: 'Compare 1 to 10 activities.' })
    }
    return context.run(Tools.use((tools) => tools.compareRuns(input.ids)))
  })

const dailyReadiness = tool({
  name: 'daily_readiness',
  title: 'Daily readiness',
  description:
    "Recovery for a morning go/no-go: per day (newest first) sleep (hours, score, bedtime, wake), overnight HRV and its weekly average, status and baseline band, resting HR, body battery, Garmin's training readiness, acute load and stress; the 28-day baseline before the window; the activities of the last 3 days; the workouts planned today and tomorrow.",
  method: 'GET',
  path: '/readiness',
  tags: ['wellness'],
  readOnly: true,
  openWorld: false,
})
  .input(
    standard(
      Schema.Struct({
        day: opt(Day.annotate({ description: 'YYYY-MM-DD, default today (Paris)' })),
        days: opt(Schema.Int.annotate({ description: 'Days in the window, default 7' })),
      })
    )
  )
  .handler(({ input, context }) => context.run(Tools.use((tools) => tools.dailyReadiness(input))))

const sleepInsights = tool({
  name: 'sleep_insights',
  title: 'Sleep insights',
  description:
    "What the user's own nights say about sleep, descriptive (associated with, not caused by): over the last nights (days: 30, 90, 365 or all, default 90) the nights by sleep onset (before 23:30, hour by hour to 02:30, after) and by duration (under 6 h, half-hours to 8 h, 8 h and more), each with its count and, from 5 nights, the mean and t-based 95 % interval of sleep score, HRV, resting HR, body battery at wake and the morning's readiness ('few' under 5: draw nothing from it). The plan: the plateau (the shortest duration bucket from which no bucket up to the best scores more than 3 points higher), the wake time anchored on the median of the weekday mornings, the bedtime (asleep by: wake − plateau sleep − median time awake, never past the end of the best bedtime bucket; Garmin measures no sleep latency) with a French sentence giving its numbers, the 7-night debt against the plateau sleep, and tonight's target (30 min earlier on a debt of 2 h, a night 1 h short, or a quality or long day planned tomorrow). Regularity: the SD of bedtimes and wake times, social jetlag (Friday and Saturday nights' mid-sleep minus the others'), each evening of the week. Tags: journal notes about supplements or alcohol with the night after them (a note's day D is the night ending D+1), and the supplements' nights since their first note against the 28 days before, from 14 nights each side. Times are minutes from noon the day before, Paris time (22:30 is 630, 06:15 is 1095).",
  method: 'GET',
  path: '/sleep/insights',
  tags: ['wellness'],
  readOnly: true,
  openWorld: false,
})
  .input(
    standard(
      Schema.Struct({
        days: opt(
          Schema.Literals(SLEEP_PERIODS).annotate({
            description: 'Nights analysed: 30, 90, 365 or all; default 90',
          })
        ),
      })
    )
  )
  .handler(({ input, context }) =>
    context.run(Stats.use((stats) => stats.sleepInsights(input.days ?? 90)))
  )

const weeklyLoad = tool({
  name: 'weekly_load',
  title: 'Weekly load',
  description:
    "Training volume per ISO week (newest first): activities, km, hours, ascent, training load, longest activity, minutes in HR zones 1-2 / 3 / 4-5; with the acute (7 days) and chronic (weekly mean of 28 days) training load of every sport and their ratio, and Garmin's own acute load.",
  method: 'GET',
  path: '/weekly-load',
  tags: ['activities'],
  readOnly: true,
  openWorld: false,
})
  .input(
    standard(
      Schema.Struct({
        weeks: opt(Schema.Int.annotate({ description: 'Default 12' })),
        sport: opt(
          Schema.String.annotate({ description: 'Part of the sport key; every sport by default' })
        ),
      })
    )
  )
  .handler(({ input, context }) => context.run(Tools.use((tools) => tools.weeklyLoad(input))))

const plannedWorkouts = tool({
  name: 'planned_workouts',
  title: 'Planned workouts',
  description:
    "The Garmin calendar's scheduled workouts with their steps (durations, HR and pace targets), and the ids of the activities that ran them. Each has its calendar entry id (unschedule_workout's schedule_id) and its workout_id (schedule_workout, delete_workout).",
  method: 'GET',
  path: '/planned-workouts',
  tags: ['workouts'],
  readOnly: true,
  openWorld: false,
})
  .input(
    standard(
      Schema.Struct({
        from: opt(Day.annotate({ description: 'Default today' })),
        to: opt(Day.annotate({ description: 'Default from + 14 days' })),
      })
    )
  )
  .handler(({ input, context }) => context.run(Tools.use((tools) => tools.plannedWorkouts(input))))

const syncStatus = tool({
  name: 'sync_status',
  title: 'Sync status',
  description:
    "Whether the data is fresh: the Garmin session (logged in, as whom, until when its token runs before a refresh), the sync's last runs (when, files written, warnings, error; logged_out: Garmin refused the session, the user must log in again at /garmin on the web app), when it last succeeded, the latest activity, night and weigh-in stored, the files that could not be read; withings: the Withings scale's connection (configured, user_id, saved_at) and its last sync since the app started (last: Synced, LoggedOut: the user must connect Withings again at /garmin, Failed). Check it when data looks missing or stale.",
  method: 'GET',
  path: '/sync-status',
  tags: ['sync'],
  readOnly: true,
  openWorld: false,
}).handler(({ context }) =>
  context.run(
    Effect.gen(function* () {
      const status = yield* Tools.use((tools) => tools.syncStatus)
      const session = yield* GarminLogin.use((login) => login.status)
      return { garmin_session: session, withings: yield* withingsStatus, ...status }
    })
  )
)

const schema = tool({
  name: 'schema',
  title: 'Garmin data schema',
  description: `List the tables and views with their columns.\n\n${DATA_MODEL}`,
  method: 'GET',
  path: '/schema',
  tags: ['sql'],
  readOnly: true,
  openWorld: false,
}).handler(({ context }) =>
  context.run(
    Reader.use((reader) =>
      Effect.map(reader.columns, (columns) => {
        const tables: Record<
          string,
          Array<{ column: string; type: string; nullable: boolean }>
        > = {}
        for (const column of columns) {
          const table = tables[column.table_name] ?? []
          table.push({
            column: column.column_name,
            type: column.data_type,
            nullable: column.not_null === 0,
          })
          tables[column.table_name] = table
        }
        return tables
      })
    )
  )
)

const sql = tool({
  name: 'sql',
  title: 'Query Garmin data',
  description: `Run one read-only SQLite statement on the user's Garmin data and return the rows as JSON. Prefer the typed tools; use this for anything they do not answer.\n\n${DATA_MODEL}\n\n${QUERY_GUIDE}`,
  method: 'POST',
  path: '/sql',
  tags: ['sql'],
  readOnly: true,
  openWorld: false,
})
  .input(
    standard(
      Schema.Struct({
        query: Schema.String.annotate({ description: 'A single read-only SQL statement' }),
      })
    )
  )
  .handler(({ input, context }) =>
    context.run(
      Reader.use((reader) => Effect.map(reader.query(input.query), (result) => capRows(result)))
    )
  )

// --- The user's journal: what the data does not say (a pain, a feeling, a meal)

const PAIN_CODES =
  'kind: vive = sharp, sourde = dull ache, brulure = burning, raideur = stiffness, tiraillement = pulling or tightness, pointe = stabbing point. when: effort = while running, descente = downhill, cote = uphill, repos = at rest, nuit = at night, reveil = on waking, escaliers = on stairs, palpation = when pressed.'

const logNote = tool({
  name: 'log_note',
  title: "Add a note to the user's journal",
  description:
    "Keep a note in the user's journal, in their words: a pain and where, how a run felt, sleep, food, alcohol, an injury's progress. It is written to its own file in data/journal/ (kept across rebuilds) and shows on the web app's home page for 14 days; the journal table holds them all for the SQL. A pain on a body structure can carry `body`, as the web app's body map (/body) writes it: it then shows on the map and in body_history. Returns the note as saved.",
  method: 'POST',
  path: '/journal',
  tags: ['journal'],
  readOnly: false,
  openWorld: false,
})
  .input(
    standard(
      Schema.Struct({
        day: opt(
          JournalNoteJson.fields.day.annotate({ description: 'YYYY-MM-DD, default today (Paris)' })
        ),
        text: JournalNoteJson.fields.text.annotate({
          description: "The note, in the user's words (at most 2000 characters)",
        }),
        body: opt(
          NoteBodyJson.annotate({
            description: `A pain on one structure of the anatomy model. structure: the model's id, its structure's name in snake_case with _l or _r for a side and no suffix on the midline (e.g. vastus_lateralis_r, calcaneal_tendon_l, patellar_ligament_r, iliotibial_tract_l, linea_alba); an unknown id is refused with the closest ones. side: left, right or midline, the structure's own (a midline structure takes left or right too). pain: 0-10. point: [x, y, z] in metres on the model, only when clicked on it. since: YYYY-MM-DD, the day it started. ${PAIN_CODES}`,
          })
        ),
      })
    )
  )
  .handler(({ input, context }) => context.run(Journal.use((journal) => journal.log(input))))

const bodyHistoryTool = tool({
  name: 'body_history',
  title: 'Body pain history',
  description: `The pains the user pinned on the web app's 3D body map (/body) or logged with log_note's body, over the last \`days\` days (default 30, ending today in Paris). pins, by day: the day, the structure's id and its French, English and Latin names (label: the French name with the side), tissue (muscle, tendon, ligament, bone, fascia, cartilage, bursa, fat_pad), region, side, pain 0-10, kind, when, since, the note's text, the point clicked. structures, the worst now first: per structure and side, its pains note by note in day order (series), its first and last day, latest, max and change (latest minus first: above 0 it is getting worse). ${PAIN_CODES} Use it to triage a pain (which structure, how it evolves, what brings it on) before suggesting rest or exercises; it is not a diagnosis.`,
  method: 'GET',
  path: '/body/history',
  tags: ['journal'],
  readOnly: true,
  openWorld: false,
})
  .input(
    standard(
      Schema.Struct({
        days: opt(
          Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3650 })).annotate({
            description: 'Days back from today, default 30',
          })
        ),
      })
    )
  )
  .handler(({ input, context }) =>
    context.run(
      Effect.gen(function* () {
        const { from, to, notes } = yield* Tools.use((tools) => tools.bodyNotes(input.days ?? 30))
        const catalog = yield* Anatomy.use(readableCatalog)
        return bodyHistory({ from, to }, notes, catalog)
      })
    )
  )

// --- The caffeine the user drinks: what is left at bedtime, and the nights after

const CAFFEINE_MODEL = `Estimates, not measurements: caffeine left = Σ mg · 0.5^(hours since / ${HALF_LIFE_H}), with EFSA 2015's mean adult half-life of ${HALF_LIFE_H} h (anyone's own lies between ~2 and ~10 h). EFSA 2015's limits for a healthy adult: ${DAY_LIMIT_MG} mg a day, ${DOSE_LIMIT_MG} mg at once. Bedtime is ${TARGET_BEDTIME} in Paris for now. cutoff: the latest a standard ${STANDARD_COFFEE_MG} mg coffee is down to ${BEDTIME_LEFT_MG} mg at bedtime (bedtime − ${HALF_LIFE_H} h·log2(${STANDARD_COFFEE_MG}/${BEDTIME_LEFT_MG})), what the web app shows as "dernier café conseillé"; rule_cutoff: Gardiner et al. 2023's meta-analysis, coffee at least ${RULE_HOURS} h before bed. Instants are UTC (at, time), each with its Paris clock (clock).`

const logCaffeine = tool({
  name: 'log_caffeine',
  title: 'Log a caffeinated drink',
  description: `Log a drink with caffeine the user had ("un double expresso à 15h"): its kind, and its time when it was not just now. It is written to its own file in data/caffeine/ and shows on the web app's Café card and /cafe page. mg defaults to the kind's: ${DRINK_KINDS.map((kind) => `${kind} ${DRINKS[kind].mg ?? '(give mg)'}`).join(', ')}. Refused: a day without a time, a time in the future, custom without mg. Returns the intake as saved (its time is the key delete_caffeine takes).`,
  method: 'POST',
  path: '/caffeine',
  tags: ['caffeine'],
  readOnly: false,
  openWorld: false,
})
  .input(
    standard(
      Schema.Struct({
        kind: CaffeineIntakeJson.fields.kind,
        mg: opt(Mg.annotate({ description: "Caffeine in mg (1-1000), default the kind's" })),
        day: opt(Day.annotate({ description: 'YYYY-MM-DD in Paris, default today; needs time' })),
        time: opt(ClockSchema.annotate({ description: 'HH:MM in Paris, default now' })),
        note: opt(
          CaffeineIntakeJson.fields.note.annotate({ description: 'At most 200 characters' })
        ),
      })
    )
  )
  .handler(({ input, context }) => context.run(Caffeine.use((caffeine) => caffeine.log(input))))

const caffeineToday = tool({
  name: 'caffeine_today',
  title: "Today's caffeine",
  description: `Today's caffeine (Paris): the intakes (with their Paris clock), total_mg and over_day_limit, strong (intakes over ${DOSE_LIMIT_MG} mg at once), now_mg (left in the body now), bedtime_mg (left at bedtime), cutoff and cutoff_passed, rule_cutoff. ${CAFFEINE_MODEL}`,
  method: 'GET',
  path: '/caffeine/today',
  tags: ['caffeine'],
  readOnly: true,
  openWorld: false,
}).handler(({ context }) => context.run(Caffeine.use((caffeine) => caffeine.today)))

const deleteCaffeine = tool({
  name: 'delete_caffeine',
  title: 'Delete a caffeine intake',
  description:
    "Delete one intake logged by mistake, named by its time (log_caffeine's answer, caffeine_today's intakes, or the caffeine table): its file goes, then its row. Returns the intake deleted.",
  method: 'DELETE',
  path: '/caffeine/{time}',
  tags: ['caffeine'],
  readOnly: false,
  destructive: true,
  idempotent: true,
  openWorld: false,
})
  .input(
    standard(
      Schema.Struct({
        time: InstantSchema.annotate({
          description: 'The intake’s time, e.g. 2026-11-24T14:00:00.000Z',
        }),
      })
    )
  )
  .handler(({ input, context }) =>
    context.run(Caffeine.use((caffeine) => caffeine.remove(input.time)))
  )

const caffeineVsSleep = tool({
  name: 'caffeine_vs_sleep',
  title: 'Caffeine against sleep',
  description: `Each night fully tracked (from the second day after the first intake), the caffeine left at its sleep onset (Garmin's sleep_start; the time it took to fall asleep is not in the data) and the last intake in the 24 h before, with the sleep score, HRV, resting HR and deep sleep (nights). comparison: the nights with more than ${HIGH_MG} mg left against the others, n and means per measure, diff = high − low; too-few under ${MIN_NIGHTS} nights a side (and per measure). An association, never a cause: say "associé à". ${CAFFEINE_MODEL}`,
  method: 'GET',
  path: '/caffeine/sleep',
  tags: ['caffeine'],
  readOnly: true,
  openWorld: false,
}).handler(({ context }) => context.run(Caffeine.use((caffeine) => caffeine.sleep)))

// --- The races the user prepares: a course (GPX), its facts, and the plan per segment

const RACE_MODEL = `A race is its GPX course (data/races/<slug>.gpx), its facts (name, date, start time, aid stations, cutoffs) and the plan written by plan_race. The course is resampled every 25 m (altitudes smoothed over ±50 m) and cut into climbs (≥ +3 %), descents (≤ −3 %) and flats, 5 km at most, numbered from 1. km_effort = km + D+/100. The prediction carries the user's best run of the last year (least moving time once scaled with Riegel 1.06, on its grade-adjusted distance) to the race's grade-adjusted distance (Strava's 2017 GAP curve: −9 % ≈ 0.88, +10 % ≈ 1.49), then splits it over the segments by effort; a planned pace replaces its segment's time. The grade curve is Strava's population fit, not the user's: their runs are flat, so nothing here checks it on steep grades. It knows nothing of technical terrain, walking or heat: adjust with planned paces. Gels: one every gel_carbs_g / carbs_g_per_h hours.`

const SlugInput = SlugSchema.annotate({ description: 'The race (list_races)' })

const listRaces = tool({
  name: 'list_races',
  title: 'List the races',
  description: `The user's target races, by date: slug, name, date, km, D+, D−, km-effort, whether a plan exists, the predicted finish (seconds). A race whose files cannot be read is listed with its problem. ${RACE_MODEL}`,
  method: 'GET',
  path: '/races',
  tags: ['races'],
  readOnly: true,
  openWorld: false,
}).handler(async ({ context }) => ({
  races: await context.run(Races.use((races) => races.list)),
}))

const getRace = tool({
  name: 'get_race',
  title: 'Get a race and its plan',
  description: `One race in full: its facts, totals (km, D+, D−, km-effort, lowest and highest point), its segments (km from–to, D+/D−, net grade, km-effort, equivalent flat km) each with its plan entry, the fuel numbers, and the prediction: the reference run, per segment its time, start and end (seconds from the start, clock times with a start time), gels and water; the passing times at aid stations and cutoffs (with the margin to each cutoff); the gels on the timeline. warnings: plan entries whose segment changed (not applied), points past the finish. prediction is null without a run of 3 km or more in the last year. ${RACE_MODEL}`,
  method: 'GET',
  path: '/races/{slug}',
  tags: ['races'],
  readOnly: true,
  openWorld: false,
})
  .input(standard(Schema.Struct({ slug: SlugInput })))
  .handler(async ({ input, context }) => {
    const race = await context.run(Races.use((races) => races.get(input.slug)))
    if (Option.isNone(race)) throw new ORPCError('NOT_FOUND', { message: `No race ${input.slug}.` })
    return race.value.view
  })

const addRace = tool({
  name: 'add_race',
  title: 'Add or update a race',
  description: `Add a target race from its GPX text (a track or a route; without altitudes they are read from the elevation tiles: a local area of data/terrain holding the course, else AWS Terrain Tiles), with its facts: name, date, start time, aid stations (km, name, what they offer) and cutoffs (km, clock time). Its slug is its name and year; a taken slug is refused. With slug: that race's facts are replaced (send them all), and its course too when gpx is given (a plan whose segments then moved is not applied until plan_race again). Returns the race as get_race.`,
  method: 'POST',
  path: '/races',
  tags: ['races'],
  readOnly: false,
  destructive: true,
  openWorld: true,
})
  .input(
    standard(
      Schema.Struct({
        slug: opt(SlugInput.annotate({ description: 'An existing race to update' })),
        ...FactsInputSchema.fields,
        gpx: opt(
          Schema.String.check(Schema.isMaxLength(MAX_GPX_BYTES)).annotate({
            description: "The GPX file's text (20 MB at most); required for a new race",
          })
        ),
      })
    )
  )
  .handler(async ({ input: { slug, gpx, ...fields }, context }) => {
    if (slug === undefined && gpx === undefined) {
      throw new ORPCError('BAD_REQUEST', {
        message: 'gpx is required for a new race (or give the slug to update one).',
      })
    }
    const facts = await context.run(Schema.decodeUnknownEffect(FactsInputSchema)(fields))
    const saved = await context.run(
      Races.use((races) =>
        slug === undefined
          ? races.add({ facts, gpx: gpx ?? '' })
          : races.update(slug, { facts, gpx })
      )
    )
    const race = await context.run(Races.use((races) => races.get(saved)))
    if (Option.isNone(race)) throw new ORPCError('NOT_FOUND', { message: `No race ${saved}.` })
    return race.value.view
  })

const planRace = tool({
  name: 'plan_race',
  title: 'Write the plan of a race',
  description: `Write the user's plan for a race, replacing the last one: per segment (get_race's numbers) a target pace ("6'05/km" or 365 s/km, 2'00 to 60'00 a km; its time then replaces the model's) or heart-rate band, what to eat and drink there, notes; and the race's carbs per hour, grams per gel and water per hour. Write it once agreed with the user. Returns the race as get_race, with the new times.`,
  method: 'POST',
  path: '/races/{slug}/plan',
  tags: ['races'],
  readOnly: false,
  destructive: true,
  idempotent: true,
  openWorld: false,
})
  .input(
    standard(
      Schema.Struct({
        slug: SlugInput,
        ...PlanInputSchema.fields,
      })
    )
  )
  .handler(({ input: { slug, ...plan }, context }) =>
    context.run(Races.use((races) => races.plan(slug, plan)))
  )

// --- The nutrition plan agreed with the user, the weight trend against it, the supplements and
// the peak weight

const NUTRITION_MODEL = `The nutrition plan (data/nutrition/plan.json; without the file, the plan agreed on 2026-11-16): kcal per day type (rest, easy, quality, long), carbs per hour during a long day's run, protein a day, the loss aimed for in a deficit phase (kg a week) and the stall threshold, the target weight, the phases (deficit, maintenance). A day's type comes from its activities once there are any, else from its planned workouts: long = 75 min or 15 km of running; quality = 20 min in HR zones 4-5 once done, or planned with a quality word in its name or description (tempo, seuil, threshold, fractionné, VMA, intervalles, fartlek, côtes), an HR target above zone 4's floor (the latest run's hr_zone_bounds), an HR zone 4-5 target, or repetitions (a repeated interval with a pace target, or of 1:00 or 200 m at least: not strides); easy = any other session; rest = nothing. The weight trend: one weigh-in a day (the morning's), the 7-day mean, its least-squares slope over the last 28 days of the current phase (only means whose 7 days are all in the phase); it takes 4 weigh-ins and 14 days of means, else too-few.`

const SUPPLEMENTS_MODEL = `The supplements (data/nutrition/supplements.json; without the file, none): each one's name, brand, what one unit is (gélule…), its intakes (moment: breakfast, lunch, dinner, bedtime or run, and the units each time), its contents per serving (serving_units units): nutrient slugs with an amount in g, mg or µg (vitamin D in µg: 1 µg = 40 IU) and the salt or extract (form), its rhythm (every_days: 1 = daily, N = every N days counted from start, its first intake), start and stop (its last day) and a note. A product taken at lunch and at dinner is one supplement with two intakes. The nutrient slugs ${Object.keys(UPPER_LIMITS).join(', ')} are checked against their adult upper limit (EFSA) and ${Object.keys(CAUTIONS).join(', ')} carries a caution: write them exactly so.`

const nutritionPlan = tool({
  name: 'nutrition_plan',
  title: 'Read the nutrition plan',
  description: `The nutrition plan agreed with the user, and saved: false when it is the default (no file yet). ${NUTRITION_MODEL}`,
  method: 'GET',
  path: '/nutrition/plan',
  tags: ['nutrition'],
  readOnly: true,
  openWorld: false,
}).handler(({ context }) => context.run(Nutrition.use((nutrition) => nutrition.plan)))

const setNutritionPlan = tool({
  name: 'set_nutrition_plan',
  title: 'Write the nutrition plan',
  description: `Replace the nutrition plan, sent whole (as nutrition_plan returns it). Write it once agreed with the user. Returns the plan saved. ${NUTRITION_MODEL}`,
  method: 'POST',
  path: '/nutrition/plan',
  tags: ['nutrition'],
  readOnly: false,
  destructive: true,
  idempotent: true,
  openWorld: false,
})
  .input(standard(NutritionPlanJson))
  .handler(({ input, context }) =>
    context.run(Nutrition.use((nutrition) => nutrition.setPlan(input)))
  )

const supplementsTool = tool({
  name: 'supplements',
  title: 'Read the supplements',
  description: `The supplements the user takes, as set_supplements writes them, and saved: false when there is no file yet. ${SUPPLEMENTS_MODEL}`,
  method: 'GET',
  path: '/nutrition/supplements',
  tags: ['nutrition'],
  readOnly: true,
  openWorld: false,
}).handler(({ context }) => context.run(Nutrition.use((nutrition) => nutrition.supplements)))

const setSupplements = tool({
  name: 'set_supplements',
  title: 'Write the supplements',
  description: `Replace the supplements, the whole list at once (as supplements returns it, without saved). Write it when the user starts, stops or changes one. Returns the list saved. ${SUPPLEMENTS_MODEL}`,
  method: 'POST',
  path: '/nutrition/supplements',
  tags: ['nutrition'],
  readOnly: false,
  destructive: true,
  idempotent: true,
  openWorld: false,
})
  .input(standard(SupplementsJson))
  .handler(({ input, context }) =>
    context.run(Nutrition.use((nutrition) => nutrition.setSupplements(input)))
  )

const nutritionToday = tool({
  name: 'nutrition_today',
  title: "Today's nutrition target, weight trend, supplements and peak weight",
  description: `What the nutrition plan says today (Paris): the day's type and why (from what was done, else planned, else nothing), its target (kcal, protein, carbs per hour during a long run), the current phase, the weight trend (kg_per_week over its window, negative = losing, with the weigh-ins in it; too-few when there are not enough) and its status: on-track (losing within the plan's range), too-fast (losing more than its max: muscle and injury risk), slow (less than its min), stalled (less than stall_kg_per_week once the phase is stall_after_days old), too-few (not enough weigh-ins to say), maintenance, no-phase; and the latest weigh-in.
Supplements: today's intakes by moment, every supplement not stopped with its schedule (dose or off today with its next dose day, upcoming with its start), and totals: each nutrient's daily average from totals.from (once every supplement not stopped has started) with its upper limit (scope supplements = from supplements alone, total = food included), status over / under / no-limit, and a caution where one applies.
Peak: the lean mass of the last 14 days' weigh-ins with a fat % (weight × (1 - fat %), the Withings impedance scale: its fat % is ±5 points, bia_kg is the peak range under that error), the peak weight range at 10-13 % body fat assuming the lean mass is kept (10 % is the floor: never aim below it; low energy availability, RED-S, is the risk under it), and the plan's target_kg as the near target; each with its gap and, at the plan's loss per week, the weeks and dates (fastest, slowest) and where they fall against the current deficit phase's end (deficit: within = both dates before it, fastest-only = only the fastest, after = neither; null outside a deficit phase). too-few: fewer than 3 weigh-ins with a fat %; no-weigh-in: none in 14 days.
Levers, ranked (room, then untracked, then fine, then no-data; the biggest kcal effect first): rest days (days without a session in the 28 before today; meals are not recorded), breakfast (the pastry swap), protein (the plan's g per kg of weight), strength (sessions in the 8 full weeks before this one, 2 a week wanted), running (km a week over those weeks against a first marathon plan's 24 km first week), steps (a day over the 28 days), sleep (hours a night over 28 nights, and bedtimes after 00:30 Paris time); each with its measured value and window, its kcal_per_day effect when it is energy, and a French sentence. ${NUTRITION_MODEL}`,
  method: 'GET',
  path: '/nutrition/today',
  tags: ['nutrition'],
  readOnly: true,
  openWorld: false,
}).handler(({ context }) =>
  context.run(
    Effect.map(
      Nutrition.use((nutrition) => nutrition.view(90)),
      todayOf
    )
  )
)

// --- The strength programme (the Renfo page): planned, pushed to the watch, tracked

const STRENGTH_MODEL = `The strength programme (data/strength/program.json; without the file, the runner's programme agreed on 2026-11-24): sessions a week (2), hours between two sessions (48), the pain rule (an exercise loading a structure pinned on the body map with a pain of threshold/10 or more in the last days takes its regression: 3/10 over 14 days), the phases tied to the races (base, build, taper, mont-blanc: their doses and their volume, a taper's sets halved; a day in none is a recovery week without sessions), the sessions (A: heavy and slow for the patellar tendon and the quads; B: hips, posterior chain, core, pogo hops in the build) and the exercises: French name, Garmin's catalog key (match exact, or closest when the catalog has none: the step's note on the watch names the real exercise), the base dose and the build's and Mont-Blanc's (sets, reps or seconds, tempo down-pause-up, load cue: RPE, reps in reserve), per_side, rest, primary and secondary muscles as the anatomy model's structure ids (body_history's), how to do it, its regression, and a home variant (maison: bodyweight, band, backpack) or null when the same works at home.`

const strengthProgram = tool({
  name: 'strength_program',
  title: 'Read the strength programme',
  description: `The strength programme agreed with the user, and saved: false when it is the default (no file yet). ${STRENGTH_MODEL}`,
  method: 'GET',
  path: '/strength/program',
  tags: ['strength'],
  readOnly: true,
  openWorld: false,
}).handler(({ context }) => context.run(Strength.use((strength) => strength.program)))

const setStrengthProgram = tool({
  name: 'set_strength_program',
  title: 'Write the strength programme',
  description: `Replace the strength programme, sent whole (as strength_program returns it). Write it once agreed with the user. Every muscle must be a muscle or tendon of the anatomy model (refused with the closest ids), every Garmin key in the catalog (find_exercises). Returns the programme saved. ${STRENGTH_MODEL}`,
  method: 'POST',
  path: '/strength/program',
  tags: ['strength'],
  readOnly: false,
  destructive: true,
  idempotent: true,
  openWorld: false,
})
  .input(standard(StrengthProgramJson))
  .handler(({ input, context }) =>
    context.run(Strength.use((strength) => strength.setProgram(input)))
  )

const strengthHistory = tool({
  name: 'strength_history',
  title: 'The strength sessions done',
  description:
    "The strength sessions done (activities of sport strength_training, their sets in strength_sets): the sessions per week (Monday) against the programme's target, the total, per exercise (the programme's, then any other done twice) its progression session by session (sets, reps, top load, Epley's estimated 1RM from 1 to 12 reps, volume = Σ load × reps, seconds held), and the last session's sets by exercise.",
  method: 'GET',
  path: '/strength/history',
  tags: ['strength'],
  readOnly: true,
  openWorld: false,
})
  .input(
    standard(
      Schema.Struct({
        weeks: opt(
          Schema.Int.check(Schema.isBetween({ minimum: 4, maximum: 52 })).annotate({
            description: 'Weeks of counts, default 12',
          })
        ),
      })
    )
  )
  .handler(({ input, context }) =>
    context.run(Strength.use((strength) => strength.history(input.weeks ?? 12)))
  )

const scheduleStrength = tool({
  name: 'schedule_strength',
  title: "Place the week's strength sessions on the watch",
  description: `Place a week's strength sessions around its runs and push them to the Garmin calendar as strength workouts (create_workout's, one per session, scheduled on its day). Rules: never the day before a quality session or a long run (from planned_workouts and the runs done, judged as nutrition_today's day type), never on the long run's day, best right after the quality session (hard days hard), then an easy day, then a day without a run; at least min_hours_apart from another strength session, the neighbouring weeks' included; never a past day; sessions already done or in the calendar that week count toward the target. Sessions follow the programme's order after the last one named "Renfo X - …". Each session carries the pain rule's regressions (also in the workout's description on the watch). A day that already holds a calendar entry gets a warning (two scheduled workouts a day can stop the watch offering the run): the push refuses it unless allow_shared_days. ${WATCH}
dry_run: true returns the proposal and the exact workouts (Garmin's JSON, the steps as the watch shows them), sending nothing and calling nothing on Garmin.`,
  method: 'POST',
  path: '/strength/schedule',
  tags: ['strength', 'workouts'],
  readOnly: false,
  openWorld: true,
})
  .input(
    standard(
      Schema.Struct({
        week: opt(
          Day.annotate({
            description: 'Any day of the week to place (YYYY-MM-DD); default next week',
          })
        ),
        variant: opt(
          Schema.Literals(['gym', 'maison']).annotate({
            description: 'maison: the home variants (a weekend at the parents’); default gym',
          })
        ),
        dry_run: opt(
          Schema.Boolean.annotate({ description: 'Return the proposal without sending it' })
        ),
        allow_shared_days: opt(
          Schema.Boolean.annotate({
            description: 'Push even on a day that already holds a calendar entry',
          })
        ),
      })
    )
  )
  .handler(({ input, context }) =>
    context.run(
      Effect.gen(function* () {
        const day = input.week ?? addDays(mondayOf(yield* parisToday), 7)
        const proposal = yield* Strength.use((strength) =>
          strength.week(day, input.variant ?? 'gym')
        )
        const answer = proposalOf(proposal)
        if (input.dry_run === true) {
          return {
            dry_run: true,
            ...answer,
            workouts: proposal.sessions.map((session) => {
              const built = buildWorkout(session.workout)
              return built.ok
                ? { schedule: [session.day], steps: built.steps, payload: built.payload }
                : { schedule: [session.day], errors: built.errors }
            }),
          }
        }
        const shared = proposal.sessions.filter((session) => session.warning !== null)
        if (shared.length > 0 && input.allow_shared_days !== true) {
          return yield* new StrengthError({
            message: `Nothing pushed: ${shared.map((session) => `${session.day} (${session.warning ?? ''})`).join(' ; ')}. Pass allow_shared_days, or place the week again once the calendar changed.`,
          })
        }
        const pushed = yield* Effect.forEach(proposal.sessions, (session) =>
          GarminWorkouts.use((workouts) =>
            workouts.create(session.workout, { schedule: [session.day] })
          )
        )
        return { ...answer, pushed }
      })
    )
  )

// --- The workouts on the watch: these change the user's real Garmin Connect account

const createWorkout = tool({
  name: 'create_workout',
  title: 'Create a workout on the watch',
  description: `Create a structured workout in the user's Garmin Connect library (runs with pace or heart-rate targets, warm-up, cool-down, repeat groups; strength circuits of exercises from Garmin's catalog, see find_exercises), and schedule it on the given dates. ${WATCH}
Conventions: name runs with their date and plan, one workout per date (e.g. "Plan - tue 03/11 - Easy 40' + 5 strides"), and schedule each on its date; a routine (the same strength circuit every morning) is one workout scheduled on many dates. At most one scheduled workout a day: with two, the watch stops offering the run. A workout with the same name already in the library is refused (delete it first, or schedule the existing one).
Steps: each ends after exactly one of duration ("3:00", "45'", 180 s), distance_m, reps (strength) or lap_button: true; one target at most: pace { slow, fast } ("6'10/km", or seconds per km) or hr { low, high } (bpm). Repeat groups: { repeat: 6, steps: [...] }.
dry_run: true checks everything and returns the exact requests and the steps as the watch will show them, sending nothing. Returns the workout id, its calendar entries (schedule ids) and planned_workouts read back after the write.`,
  method: 'POST',
  path: '/workouts',
  tags: ['workouts'],
  readOnly: false,
  openWorld: true,
})
  .input(
    standard(
      Schema.Struct({
        ...WorkoutSchema.fields,
        schedule: opt(
          Schema.Array(Day).annotate({
            description: 'Dates to schedule it on (YYYY-MM-DD); none: library only',
          })
        ),
        dry_run: opt(
          Schema.Boolean.annotate({ description: 'Return the requests without sending them' })
        ),
        allow_duplicate_name: opt(
          Schema.Boolean.annotate({
            description: 'Create it even if a workout has this name already',
          })
        ),
      })
    )
  )
  .handler(({ input: { schedule, dry_run, allow_duplicate_name, ...workout }, context }) =>
    context.run(
      GarminWorkouts.use((workouts) =>
        workouts.create(workout, { schedule, dry_run, allow_duplicate_name })
      )
    )
  )

const scheduleWorkout = tool({
  name: 'schedule_workout',
  title: 'Schedule a workout on the watch',
  description: `Schedule a workout of the library (its workout_id: list_workouts, planned_workouts) on one more date of the Garmin calendar. ${WATCH} dry_run: true returns the request without sending it. Returns the calendar entries of that day, read back.`,
  method: 'POST',
  path: '/workouts/{workout_id}/schedule',
  tags: ['workouts'],
  readOnly: false,
  openWorld: true,
})
  .input(standard(Schema.Struct({ workout_id: Id, date: Day, dry_run: opt(Schema.Boolean) })))
  .handler(({ input, context }) =>
    context.run(GarminWorkouts.use((workouts) => workouts.schedule(input)))
  )

const unscheduleWorkout = tool({
  name: 'unschedule_workout',
  title: 'Remove a workout from the calendar',
  description: `Remove one calendar entry from the Garmin calendar (the workout stays in the library). Name it exactly: its schedule_id (planned_workouts' id), its date and its workout's name, checked against Garmin's calendar before anything is removed. One entry per call, never by pattern. ${WATCH} dry_run: true returns the request without sending it.`,
  method: 'DELETE',
  path: '/calendar/{schedule_id}',
  tags: ['workouts'],
  readOnly: false,
  destructive: true,
  idempotent: true,
  openWorld: true,
})
  .input(
    standard(
      Schema.Struct({
        schedule_id: Id.annotate({ description: "The calendar entry's id (planned_workouts.id)" }),
        date: Day,
        name: Schema.String.annotate({ description: "The workout's exact name on that entry" }),
        dry_run: opt(Schema.Boolean),
      })
    )
  )
  .handler(({ input, context }) =>
    context.run(GarminWorkouts.use((workouts) => workouts.unschedule(input)))
  )

const deleteWorkout = tool({
  name: 'delete_workout',
  title: 'Delete a workout from the watch',
  description: `Delete one workout from the Garmin Connect library, with every calendar entry that schedules it. Name it exactly: its workout_id and its exact name, checked against Garmin before anything is deleted. One workout per call, never by pattern. ${WATCH} dry_run: true returns the request and the calendar entries that would go, without sending it.`,
  method: 'DELETE',
  path: '/workouts/{workout_id}',
  tags: ['workouts'],
  readOnly: false,
  destructive: true,
  idempotent: true,
  openWorld: true,
})
  .input(
    standard(
      Schema.Struct({
        workout_id: Id,
        name: Schema.String.annotate({ description: "The workout's exact name" }),
        dry_run: opt(Schema.Boolean),
      })
    )
  )
  .handler(({ input, context }) =>
    context.run(GarminWorkouts.use((workouts) => workouts.remove(input)))
  )

const listWorkouts = tool({
  name: 'list_workouts',
  title: 'List the workout library',
  description:
    "The workouts of the user's Garmin Connect library (scheduled or not), newest first: workout_id, name, sport, estimated minutes, created and updated. Read-only.",
  method: 'GET',
  path: '/workouts',
  tags: ['workouts'],
  readOnly: true,
  openWorld: true,
})
  .input(
    standard(
      Schema.Struct({
        name_contains: opt(Schema.String.annotate({ description: 'Case-insensitive' })),
        limit: opt(Schema.Int.annotate({ description: 'Default 100, at most 1000' })),
      })
    )
  )
  .handler(async ({ input, context }) => ({
    workouts: await context.run(GarminWorkouts.use((workouts) => workouts.library(input))),
  }))

const findExercisesTool = tool({
  name: 'find_exercises',
  title: 'Find strength exercises',
  description:
    "Search Garmin's catalog of strength exercises (1527, its workout editor's) for create_workout: every word must match the name or the keys, e.g. 'side plank', 'superman', 'calf raise'. Returns the name (create_workout's exercise) and the category and exercise_name keys, the closest first.",
  method: 'GET',
  path: '/exercises',
  tags: ['workouts'],
  readOnly: true,
  openWorld: false,
})
  .input(
    standard(
      Schema.Struct({
        query: Schema.String,
        limit: opt(Schema.Int.annotate({ description: 'Default 25, at most 200' })),
      })
    )
  )
  .handler(({ input }) => ({
    exercises: findExercises(input.query, Math.min(Math.max(input.limit ?? 25, 1), 200)).map(
      (entry) => ({ name: entry.name, category: entry.category, exercise_name: entry.exercise })
    ),
  }))

// The public API: the MCP's tools, /api's operations, /rpc's calls
export const garmin = {
  activities: { list: listActivities, get: getActivity, compare: compareRuns },
  readiness: dailyReadiness,
  sleepInsights,
  weeklyLoad,
  plannedWorkouts,
  syncStatus,
  schema,
  sql,
  journal: { log: logNote },
  body: { history: bodyHistoryTool },
  caffeine: {
    log: logCaffeine,
    today: caffeineToday,
    delete: deleteCaffeine,
    vsSleep: caffeineVsSleep,
  },
  races: { list: listRaces, get: getRace, add: addRace, plan: planRace },
  nutrition: {
    plan: nutritionPlan,
    setPlan: setNutritionPlan,
    today: nutritionToday,
    supplements: supplementsTool,
    setSupplements,
  },
  strength: {
    program: strengthProgram,
    setProgram: setStrengthProgram,
    history: strengthHistory,
    schedule: scheduleStrength,
  },
  workouts: {
    create: createWorkout,
    schedule: scheduleWorkout,
    unschedule: unscheduleWorkout,
    delete: deleteWorkout,
    list: listWorkouts,
  },
  exercises: { find: findExercisesTool },
}
