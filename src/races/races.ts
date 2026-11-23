import { join } from 'node:path'

import { sql } from 'drizzle-orm'
import {
  Config,
  Context,
  Effect,
  FileSystem,
  Layer,
  Option,
  Result,
  Schema,
  Semaphore,
} from 'effect'

import { addDays, parisToday } from '../days.ts'
import { Database, type DatabaseError } from '../db.ts'
import { writeAtomic } from '../files.ts'

import { type Course, courseOf, equivalentM, profileOf, segmentCourse, totals } from './course.ts'
import { type Fix, gpxOf, parseGpx } from './gpx.ts'
import { bestEffort, type Run } from './pacing.ts'
import {
  type FactsInput,
  planFile,
  type PlanInput,
  RaceError,
  type RaceFacts,
  RaceFactsJson,
  RacePlanJson,
  racePaths,
  type RaceSummary,
  type RaceView,
  raceView,
  type Slug,
  SlugSchema,
  slugOf,
} from './race.ts'
import { Terrain, type TerrainError } from './terrain.ts'
import { type Dem, demFor } from './terrarium.ts'

// The races (data/races/, the source of truth, as data/journal): written here, then read and
// computed on each request, never copied into SQLite (a plan written shows at once, and
// `ingest --rebuild` has nothing to rebuild). The prediction reads the user's runs of the last year.

export type ListedRace =
  | ({ readonly _tag: 'Race' } & RaceSummary)
  | { readonly _tag: 'Broken'; readonly slug: Slug; readonly problem: string }

export interface RaceDetail {
  readonly view: RaceView
  readonly course: Course
  readonly dem: Dem
}

const decodeFacts = Schema.decodeUnknownEffect(Schema.fromJsonString(RaceFactsJson))
const decodePlan = Schema.decodeUnknownEffect(Schema.fromJsonString(RacePlanJson))
const isSlug = Schema.is(SlugSchema)

export class Races extends Context.Service<
  Races,
  {
    readonly list: Effect.Effect<ReadonlyArray<ListedRace>, DatabaseError>
    readonly get: (
      slug: Slug
    ) => Effect.Effect<Option.Option<RaceDetail>, DatabaseError | RaceError>
    // A new race; refused when its slug is taken: never written over another
    readonly add: (race: {
      readonly facts: FactsInput
      readonly gpx: string
    }) => Effect.Effect<Slug, RaceError | TerrainError>
    // That race's facts replaced, and its course when a GPX is given
    readonly update: (
      slug: Slug,
      race: { readonly facts: FactsInput; readonly gpx?: string | undefined }
    ) => Effect.Effect<Slug, RaceError | TerrainError>
    readonly plan: (
      slug: Slug,
      plan: PlanInput
    ) => Effect.Effect<RaceView, RaceError | DatabaseError>
  }
>()('garmin/Races') {
  static readonly layer = Layer.effect(
    Races,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const { use } = yield* Database
      const terrain = yield* Terrain
      const dataDir = yield* Config.String('DATA_DIR')
      const lock = yield* Semaphore.make(1)

      const broken = (path: string, why: string) =>
        new RaceError({ reason: 'file', message: `${path} : ${why}` })

      // A file of data/, none when it is not there
      const read = (path: string) =>
        fs.readFileString(join(dataDir, path)).pipe(
          Effect.map(Option.some),
          Effect.catchTag('PlatformError', (error) =>
            error.reason._tag === 'NotFound'
              ? Effect.succeedNone
              : Effect.fail(broken(path, error.message))
          )
        )

      const write = (path: string, text: string) =>
        writeAtomic(fs, join(dataDir, path), text).pipe(
          Effect.mapError((error) => broken(path, error.message))
        )

      // The course of a GPX file's text, or why not
      const courseIn = (path: string, text: string): Effect.Effect<Course, RaceError> => {
        const fixes = parseGpx(text)
        const course = Result.isSuccess(fixes) ? courseOf(fixes.success) : null
        return course === null
          ? Effect.fail(broken(path, Result.isFailure(fixes) ? fixes.failure : 'parcours vide'))
          : Effect.succeed(course)
      }

      // A race's three files, read and checked; none without its GPX
      const load = (slug: Slug) =>
        Effect.gen(function* () {
          const paths = racePaths(slug)
          const gpx = yield* read(paths.gpx)
          if (Option.isNone(gpx)) return Option.none()
          const factsText = yield* read(paths.facts)
          if (Option.isNone(factsText)) return yield* broken(paths.facts, 'absent')
          const facts = yield* decodeFacts(factsText.value).pipe(
            Effect.mapError((error) => broken(paths.facts, error.message))
          )
          const planText = yield* read(paths.plan)
          const plan = Option.isNone(planText)
            ? null
            : yield* decodePlan(planText.value).pipe(
                Effect.mapError((error) => broken(paths.plan, error.message))
              )
          const course = yield* courseIn(paths.gpx, gpx.value)
          return Option.some({ facts, plan, course })
        })

      // The running activities of 3 km or more since a day, with their flat-equivalent distance
      // (from their samples' altitudes; their distance without any)
      const runs = (since: string) =>
        Effect.gen(function* () {
          const activities = yield* use((db) =>
            db.all<Omit<Run, 'equivalent_m'>>(sql`
              SELECT id, day, name, moving_s, distance_m FROM activities
              WHERE sport LIKE '%running%' AND sport <> 'treadmill_running'
                AND day >= ${since} AND distance_m >= 3000 AND moving_s > 0`)
          )
          const samples = yield* use((db) =>
            db.all<{ activity_id: number; distance: number; alt: number | null }>(sql`
              SELECT s.activity_id, s.distance, s.alt FROM samples s
              JOIN activities a ON a.id = s.activity_id
              WHERE a.sport LIKE '%running%' AND a.sport <> 'treadmill_running'
                AND a.day >= ${since} AND a.distance_m >= 3000 AND s.distance IS NOT NULL
              ORDER BY s.activity_id, s.t`)
          )
          const traces = Map.groupBy(samples, (sample) => sample.activity_id)
          return activities.map((run): Run => {
            const trace = traces.get(run.id) ?? []
            const profile = profileOf(
              trace.map((sample) => sample.distance),
              trace.map((sample) => sample.alt)
            )
            return {
              ...run,
              equivalent_m: profile === null ? run.distance_m : equivalentM(profile),
            }
          })
        })

      // The run the prediction starts from: the best of the last year
      const reference = Effect.gen(function* () {
        const today = yield* parisToday
        return bestEffort(yield* runs(addDays(today, -365)))
      })

      const get = Effect.fn('Races.get')(function* (slug: Slug) {
        const loaded = yield* load(slug)
        if (Option.isNone(loaded)) return Option.none<RaceDetail>()
        const { facts, plan, course } = loaded.value
        const view = raceView({ slug, facts, plan, course, reference: yield* reference })
        const dem = demFor(yield* terrain.areas, totals(course).bbox)
        return Option.some<RaceDetail>({ view, course, dem })
      })

      const list = Effect.gen(function* () {
        const names = yield* fs
          .readDirectory(join(dataDir, 'races'))
          .pipe(Effect.orElseSucceed((): Array<string> => []))
        const slugs = names.flatMap((name) => {
          const slug = name.endsWith('.gpx') ? name.slice(0, -4) : ''
          return isSlug(slug) ? [slug] : []
        })
        const best = yield* reference
        const listed = yield* Effect.forEach(slugs.toSorted(), (slug) =>
          load(slug).pipe(
            Effect.map((loaded): Array<ListedRace> => {
              if (Option.isNone(loaded)) return []
              const { facts, plan, course } = loaded.value
              const { prediction, ...view } = raceView({
                slug,
                facts,
                plan,
                course,
                reference: best,
              })
              return [
                {
                  _tag: 'Race',
                  slug: view.slug,
                  name: view.name,
                  date: view.date,
                  km: view.km,
                  d_plus: view.d_plus,
                  d_minus: view.d_minus,
                  km_effort: view.km_effort,
                  planned: view.planned,
                  predicted_s: prediction?.total_s ?? null,
                },
              ]
            }),
            Effect.catchTag('RaceError', (error) =>
              Effect.succeed<Array<ListedRace>>([{ _tag: 'Broken', slug, problem: error.message }])
            )
          )
        )
        return listed
          .flat()
          .toSorted((a, b) =>
            a._tag === 'Race' && b._tag === 'Race' ? a.date.localeCompare(b.date) : 0
          )
      })

      // A GPX's text as stored, and where its altitudes come from: as given when it has some,
      // else from the DEM (the file rewritten with them)
      const prepared = (path: string, text: string) =>
        Effect.gen(function* () {
          const fixes = parseGpx(text)
          if (Result.isFailure(fixes)) {
            return yield* new RaceError({ reason: 'gpx', message: fixes.failure })
          }
          const stored = yield* withAltitudes(fixes.success)
          yield* courseIn(path, stored.text ?? text).pipe(
            Effect.mapError((error) => new RaceError({ reason: 'gpx', message: error.message }))
          )
          return stored
        })

      const withAltitudes = (
        fixes: ReadonlyArray<Fix>
      ): Effect.Effect<{ text: string | null; elevation: RaceFacts['elevation'] }, TerrainError> =>
        fixes.some((fix) => fix.ele !== null)
          ? Effect.succeed({ text: null, elevation: { source: 'gpx' as const } })
          : Effect.map(terrain.elevations(fixes), ({ metres, dem }) => ({
              text: gpxOf(fixes.map((fix, i) => ({ ...fix, ele: metres[i] ?? 0 }))),
              elevation: { source: 'dem' as const, attribution: dem.attribution },
            }))

      const save = (slug: Slug, facts: FactsInput, gpx: string | undefined) =>
        Effect.gen(function* () {
          const paths = racePaths(slug)
          const stored = gpx === undefined ? null : yield* prepared(paths.gpx, gpx)
          const elevation =
            stored?.elevation ??
            (yield* load(slug).pipe(
              Effect.map((loaded) =>
                Option.isSome(loaded) ? loaded.value.facts.elevation : { source: 'gpx' as const }
              )
            ))
          if (stored !== null) yield* write(paths.gpx, stored.text ?? gpx ?? '')
          const file: RaceFacts = { ...facts, elevation }
          yield* write(paths.facts, `${JSON.stringify(file, null, 2)}\n`)
          return slug
        })

      const exists = (slug: Slug) =>
        fs.exists(join(dataDir, racePaths(slug).gpx)).pipe(Effect.orElseSucceed(() => false))

      const add = Effect.fn('Races.add')(function* (race: {
        readonly facts: FactsInput
        readonly gpx: string
      }) {
        const slug = slugOf(race.facts.name, race.facts.date)
        if (slug === null) {
          return yield* new RaceError({ reason: 'file', message: 'nom sans lettre ni chiffre' })
        }
        if (yield* exists(slug)) {
          return yield* new RaceError({
            reason: 'exists',
            message: `La course ${slug} existe déjà : add_race avec slug pour la remplacer.`,
          })
        }
        return yield* save(slug, race.facts, race.gpx)
      }, lock.withPermits(1))

      const update = Effect.fn('Races.update')(function* (
        slug: Slug,
        race: { readonly facts: FactsInput; readonly gpx?: string | undefined }
      ) {
        if (!(yield* exists(slug))) {
          return yield* new RaceError({ reason: 'missing', message: `Pas de course ${slug}.` })
        }
        return yield* save(slug, race.facts, race.gpx)
      }, lock.withPermits(1))

      const plan = Effect.fn('Races.plan')(function* (slug: Slug, input: PlanInput) {
        const loaded = yield* load(slug)
        if (Option.isNone(loaded)) {
          return yield* new RaceError({ reason: 'missing', message: `Pas de course ${slug}.` })
        }
        const file = planFile(input, segmentCourse(loaded.value.course))
        if (Result.isFailure(file)) {
          return yield* new RaceError({ reason: 'plan', message: file.failure })
        }
        yield* lock.withPermits(1)(
          write(racePaths(slug).plan, `${JSON.stringify(file.success, null, 2)}\n`)
        )
        const best = yield* reference
        return raceView({ slug, ...loaded.value, plan: file.success, reference: best })
      })

      return Races.of({ list, get, add, update, plan })
    })
  )
}
