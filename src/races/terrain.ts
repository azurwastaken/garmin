import { join } from 'node:path'

import { Config, Context, Effect, FileSystem, Layer, Option, Schema } from 'effect'
import { HttpClient, HttpClientRequest } from 'effect/http'

import { body } from '../http-body.ts'

import type { LatLon } from './gpx.ts'
import {
  AWS,
  boundsOf,
  decodePng,
  type Dem,
  demFor,
  type Ortho,
  orthoFile,
  type Raster,
  terrainFile,
  terrariumAt,
  tileOf,
} from './terrarium.ts'

// The elevation tiles: the local areas of data/terrain (IGN, served read-only at /terrain) and
// AWS's, for the race page's 3D map and for a GPX without altitudes; and the aerial photos the map
// drapes on them, the areas of data/ortho (IGN, served read-only at /ortho).

export class TerrainError extends Schema.TaggedError<TerrainError>()('TerrainError', {
  message: Schema.String,
}) {}

// An area's tiles.json (TileJSON 3), as the terrain and ortho pipelines write it
const AreaJson = Schema.Struct({
  name: Schema.optionalKey(Schema.String),
  attribution: Schema.String,
  tiles: Schema.Array(Schema.String),
  minzoom: Schema.Int,
  maxzoom: Schema.Int,
  bounds: Schema.Tuple([Schema.Finite, Schema.Finite, Schema.Finite, Schema.Finite]),
  tileSize: Schema.Literal(256),
})
type AreaTiles = typeof AreaJson.Type
const decodeTerrainJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({ ...AreaJson.fields, encoding: Schema.Literal('terrarium') })
  )
)
const decodeOrthoJson = Schema.decodeUnknownEffect(Schema.fromJsonString(AreaJson))

// What a served area's file is: its bytes and content type
export interface AreaFile {
  readonly bytes: Uint8Array
  readonly type: string
}

// A served area's file as the answer: 404 when none, else cached a day (start.ts's default is
// no-store, and a map asks for hundreds of tiles)
export const tileResponse = (found: Option.Option<AreaFile>) =>
  Option.match(found, {
    onNone: () => new Response('Not found\n', { status: 404 }),
    onSome: ({ bytes, type }) =>
      new Response(new Uint8Array(bytes), {
        headers: { 'content-type': type, 'cache-control': 'private, max-age=86400' },
      }),
  })

// The zoom the server samples at: 9.5 m a pixel at 46° N, past the DEM's own detail at AWS
const SAMPLE_ZOOM = 14
const TILE_BYTES = 2 * 1024 * 1024

export class Terrain extends Context.Service<
  Terrain,
  {
    // The local areas (an unreadable tiles.json skipped, logged)
    readonly areas: Effect.Effect<ReadonlyArray<Dem>>
    // A file of data/terrain by its path under /terrain: none when not one of the shapes served
    readonly file: (splat: string) => Effect.Effect<Option.Option<AreaFile>>
    // The areas of aerial photos (an unreadable tiles.json skipped, logged)
    readonly photos: Effect.Effect<ReadonlyArray<Ortho>>
    // A file of data/ortho by its path under /ortho: none when not one of the shapes served
    readonly photo: (splat: string) => Effect.Effect<Option.Option<AreaFile>>
    // The altitude under each point, from the area holding them all, else AWS; and that DEM
    readonly elevations: (
      points: ReadonlyArray<LatLon>
    ) => Effect.Effect<{ readonly metres: Array<number>; readonly dem: Dem }, TerrainError>
  }
>()('garmin/Terrain') {
  static readonly layer = Layer.effect(
    Terrain,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const http = yield* HttpClient.HttpClient
      const dataDir = yield* Config.String('DATA_DIR')
      const root = join(dataDir, 'terrain')

      // The areas of a folder, in name order: each <area>/tiles.json its guard serves, decoded
      const areasOf = (
        folder: 'terrain' | 'ortho',
        extension: 'png' | 'jpg',
        guard: (splat: string) => unknown,
        decode: (text: string) => Effect.Effect<AreaTiles, Schema.SchemaError>
      ) =>
        Effect.gen(function* () {
          const dir = join(dataDir, folder)
          const names = yield* fs.readDirectory(dir).pipe(Effect.orElseSucceed(() => []))
          const found = yield* Effect.forEach(
            names.toSorted((a, b) => a.localeCompare(b)),
            (name) =>
              guard(`${name}/tiles.json`) === null
                ? Effect.succeed([])
                : fs.readFileString(join(dir, name, 'tiles.json')).pipe(
                    Effect.flatMap(decode),
                    Effect.map((tiles): Array<Ortho> => [
                      {
                        area: name,
                        tiles: `/${folder}/${name}/{z}/{x}/{y}.${extension}`,
                        minzoom: tiles.minzoom,
                        maxzoom: tiles.maxzoom,
                        attribution: tiles.attribution,
                        bounds: tiles.bounds,
                      },
                    ]),
                    Effect.catch((error) =>
                      // No tiles.json is not an area (data/terrain/work, scripts)
                      error._tag === 'PlatformError' && error.reason._tag === 'NotFound'
                        ? Effect.succeed([])
                        : Effect.as(
                            Effect.logWarning(`${folder}: ${name}/tiles.json unreadable`, error),
                            []
                          )
                    )
                  )
          )
          return found.flat()
        })

      // A file of a folder by its path there, when its guard serves it
      const fileOf =
        (folder: string, guard: (splat: string) => { path: string; type: string } | null) =>
        (splat: string) => {
          const served = guard(splat)
          if (served === null) return Effect.succeedNone
          return fs.readFile(join(dataDir, folder, served.path)).pipe(
            Effect.map((bytes) => Option.some<AreaFile>({ bytes, type: served.type })),
            Effect.catch((error) =>
              error.reason._tag === 'NotFound'
                ? Effect.succeedNone
                : Effect.as(
                    Effect.logWarning(`${folder}: ${served.path} unreadable`, error),
                    Option.none()
                  )
            )
          )
        }

      const areas = areasOf('terrain', 'png', terrainFile, decodeTerrainJson)
      const photos = areasOf('ortho', 'jpg', orthoFile, decodeOrthoJson)
      const file = fileOf('terrain', terrainFile)
      const photo = fileOf('ortho', orthoFile)

      const refused = (path: string, why: string) =>
        new TerrainError({ message: `tile ${path}: ${why}` })

      // A tile's bytes from AWS: HTTP 200 only, its body capped
      const fetched = (path: string) =>
        Effect.gen(function* () {
          const response = yield* http.execute(
            HttpClientRequest.get(AWS.tiles.replace('{z}/{x}/{y}.png', path))
          )
          if (response.status !== 200) return yield* refused(path, `HTTP ${response.status}`)
          return yield* body(`tile ${path}`, response, TILE_BYTES)
        }).pipe(
          Effect.mapError((error) =>
            error._tag === 'TerrainError' ? error : refused(path, error.message)
          )
        )

      // One tile's raster from the DEM: the local file, or AWS's
      const tile = (dem: Dem, z: number, x: number, y: number) => {
        const path = `${z}/${x}/${y}.png`
        const bytes: Effect.Effect<Uint8Array, TerrainError> =
          dem.area === null
            ? fetched(path)
            : fs
                .readFile(join(root, dem.area, path))
                .pipe(Effect.mapError((error) => refused(path, error.message)))
        return Effect.flatMap(bytes, (read) => {
          const raster = decodePng(read)
          return raster === null
            ? Effect.fail(refused(path, 'not a 256 px terrarium PNG'))
            : Effect.succeed(raster)
        })
      }

      const elevations = Effect.fn('Terrain.elevations')(
        function* (points: ReadonlyArray<LatLon>) {
          const dem = demFor(yield* areas, boundsOf(points))
          const z = Math.min(dem.maxzoom, SAMPLE_ZOOM)
          const at = points.map((point) => tileOf(point, z))
          const keys = [...new Set(at.map(({ x, y }) => `${x}/${y}`))]
          const rasters = new Map<string, Raster>(
            yield* Effect.forEach(
              keys,
              (key) => {
                const [x = 0, y = 0] = key.split('/').map(Number)
                return Effect.map(tile(dem, z, x, y), (raster) => [key, raster] as const)
              },
              { concurrency: 4 }
            )
          )
          const metres = yield* Effect.forEach(at, ({ x, y, px, py }) => {
            const raster = rasters.get(`${x}/${y}`)
            const value = raster === undefined ? null : terrariumAt(raster, px, py)
            return value === null
              ? Effect.fail(new TerrainError({ message: `no altitude in tile ${z}/${x}/${y}` }))
              : Effect.succeed(value)
          })
          return { metres, dem }
        },
        Effect.timeoutOrElse({
          duration: '60 seconds',
          orElse: () =>
            Effect.fail(new TerrainError({ message: 'the DEM did not answer in 60 s' })),
        })
      )

      return Terrain.of({ areas, file, photos, photo, elevations })
    })
  )
}
