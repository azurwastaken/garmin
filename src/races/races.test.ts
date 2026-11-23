import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { expect, layer } from '@effect/vitest'
import { Effect, Exit, Layer, Option, Result } from 'effect'

import { apiSummary, dataDir, fitRun, put, testLayer } from '../../test/fixtures.ts'
import { fakeGarmin } from '../../test/garmin.ts'
import { gpxText, syntheticCourse, terrariumPng } from '../../test/races.ts'
import { Ingest, Storage } from '../ingest.ts'

import { parseGpx } from './gpx.ts'
import { FactsInputSchema, type FactsInput, type Slug } from './race.ts'
import { Races } from './races.ts'
import { Terrain } from './terrain.ts'

// The elevation tiles AWS would serve: 1 200 m, rising 1 m a pixel eastwards; or no data
let noData = false
const aws = fakeGarmin(
  () =>
    new Response(
      terrariumPng((x) => (noData ? -32768 : 1200 + x)),
      { headers: { 'content-type': 'image/png' } }
    )
)

const TestLayer = testLayer(
  Races.layer.pipe(Layer.provideMerge(Terrain.layer), Layer.provideMerge(Storage)),
  aws.layer
)

const facts = (name: string): FactsInput => ({
  ...FactsInputSchema.make({ name, date: '2027-09-25' }),
})

const course = syntheticCourse([
  [3000, 0],
  [3000, 300],
  [3000, -300],
])
const withoutAltitudes = gpxText(course.points.map(({ lat, lon }) => ({ lat, lon })))

const stored = (slug: string) =>
  Effect.map(dataDir, (root) => readFileSync(join(root, 'races', `${slug}.gpx`), 'utf8'))

layer(TestLayer, { excludeTestServices: true })('Races', (it) => {
  it.effect('fills a GPX without altitudes from AWS, and says so', () =>
    Effect.gen(function* () {
      const races = yield* Races
      const slug = yield* races.add({ facts: facts('Sans altitudes'), gpx: withoutAltitudes })
      expect(slug).toBe('sans-altitudes-2027')
      expect(aws.log.every((request) => request.url.hostname === 's3.amazonaws.com')).toBe(true)
      const fixes = parseGpx(yield* stored(slug))
      expect(Result.isSuccess(fixes) && fixes.success.every((fix) => fix.ele !== null)).toBe(true)
      const race = Option.getOrThrow(yield* races.get(slug))
      expect(race.view.facts.elevation).toEqual({
        source: 'dem',
        attribution: '© Mapzen/AWS Terrain Tiles',
      })
      expect(race.dem.area).toBeNull()

      // No data in the tiles: refused, nothing written
      noData = true
      const refused = yield* races
        .add({ facts: facts('Trou'), gpx: withoutAltitudes })
        .pipe(Effect.exit)
      noData = false
      expect(Exit.isFailure(refused)).toBe(true)
      expect(yield* races.get('trou-2027' as Slug)).toEqual(Option.none())
    })
  )

  it.effect('prefers a local area of data/terrain that holds the race', () =>
    Effect.gen(function* () {
      const tiles = {
        tilejson: '3.0.0',
        attribution: '© IGN',
        tiles: ['/terrain/tar/{z}/{x}/{y}.png'],
        minzoom: 8,
        maxzoom: 14,
        bounds: [6.7, 45.85, 7, 46.2],
        encoding: 'terrarium',
        tileSize: 256,
      }
      yield* put('terrain/tar/tiles.json', tiles)
      // The tiles the course crosses at zoom 14, all 2 000 m
      for (let y = 5826; y <= 5838; y += 1) {
        yield* put(
          `terrain/tar/14/8504/${y}.png`,
          terrariumPng(() => 2000)
        )
      }
      yield* put('terrain/work/notes.txt', 'not an area')
      const before = aws.log.length
      const races = yield* Races
      const slug = yield* races.add({ facts: facts('Local'), gpx: withoutAltitudes })
      expect(aws.log.length).toBe(before)
      const race = Option.getOrThrow(yield* races.get(slug))
      expect(race.view.facts.elevation).toEqual({ source: 'dem', attribution: '© IGN' })
      expect(race.view.ele_min).toBe(2000)
      expect(race.dem).toMatchObject({ area: 'tar', tiles: '/terrain/tar/{z}/{x}/{y}.png' })
    })
  )

  it.effect('serves data/terrain read-only, nothing beside it', () =>
    Effect.gen(function* () {
      yield* put('terrain/paris/tiles.json', { tiles: [] })
      yield* put('terrain/paris/12/2075/1409.png', 'png')
      yield* put('secret.txt', 'health data')
      yield* put('terrain/secret.txt', 'not served either')
      const terrain = yield* Terrain
      const served = (splat: string) => Effect.map(terrain.file(splat), Option.isSome)
      expect(yield* served('paris/tiles.json')).toBe(true)
      expect(yield* served('paris/12/2075/1409.png')).toBe(true)
      expect(yield* served('paris/12/2075/1410.png')).toBe(false)
      for (const splat of [
        '../secret.txt',
        'secret.txt',
        'paris/../../secret.txt',
        '%2e%2e/secret.txt',
        'paris/%2e%2e/%2e%2e/secret.txt',
        '/etc/passwd',
        'paris\\..\\..\\secret.txt',
        '..%2fsecret.txt',
      ]) {
        expect([splat, yield* served(splat)]).toEqual([splat, false])
      }
    })
  )

  it.effect(
    "predicts from the user's runs, and lists a broken race without hiding the others",
    () =>
      Effect.gen(function* () {
        // A 6 km run in 30 minutes, ingested from its FIT file
        yield* put('fit/2026/701.fit', fitRun({ seconds: 1800, speed: 3.333 }))
        yield* put(
          'connect/activities/2026/701.json',
          apiSummary(701, { distance: 6000, duration: 1800, movingDuration: 1800 })
        )
        yield* Ingest.use((ingest) => ingest.run())
        const races = yield* Races
        const slug = yield* races.add({
          facts: facts('Avec altitudes'),
          gpx: gpxText(course.points),
        })
        const race = Option.getOrThrow(yield* races.get(slug))
        expect(race.view.facts.elevation).toEqual({ source: 'gpx' })
        expect(race.view.prediction?.reference).toMatchObject({ id: 701, moving_s: 1800 })
        expect(race.view.prediction?.total_s).toBeGreaterThan(1800 * 1.5)

        // A hand-edited facts file: that race is listed with its problem, the others as they are
        yield* put('races/avec-altitudes-2027.json', { name: 'X' })
        const listed = yield* races.list
        expect(listed.find((r) => r.slug === 'avec-altitudes-2027')).toMatchObject({
          _tag: 'Broken',
          problem: expect.stringMatching(/^races\/avec-altitudes-2027\.json : /u),
        })
        expect(listed.find((r) => r.slug === 'local-2027')).toMatchObject({
          _tag: 'Race',
          predicted_s: expect.any(Number),
        })
      })
  )
})
