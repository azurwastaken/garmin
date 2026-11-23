import { join } from 'node:path'

import { Config, Context, Effect, FileSystem, Layer, Option, Schema } from 'effect'
import type { PlatformError } from 'effect/PlatformError'

import { SIDES } from '../journal/body-terms.ts'

import { type Catalog, TISSUES } from './catalog.ts'

// The anatomy model of the body map, in DATA_DIR/anatomy/ (CC BY-SA, outside git like all of
// data/): runner.glb and structures.json, served read-only to the page, and the catalog the journal
// checks a pinned pain against. Without the folder, the map is off and no pain is checked.

export const ANATOMY_FILES = {
  'runner.glb': 'model/gltf-binary',
  'structures.json': 'application/json',
} as const
export type AnatomyFile = keyof typeof ANATOMY_FILES

// A requested name, served only if it is one of the files: never joined to a path as it came
export const anatomyFile = (name: string): AnatomyFile | null =>
  Object.hasOwn(ANATOMY_FILES, name) ? (name as AnatomyFile) : null

export type AnatomyAnswer =
  | { readonly _tag: 'Missing' }
  // structures.json is there but is not the catalog: never handed to the page
  | { readonly _tag: 'Broken'; readonly message: string }
  | { readonly _tag: 'NotModified'; readonly etag: string }
  | {
      readonly _tag: 'Found'
      readonly etag: string
      readonly type: (typeof ANATOMY_FILES)[AnatomyFile]
      readonly bytes: Uint8Array<ArrayBuffer>
    }

// Kept, but checked again at each use: a regenerated model is seen at once
const CACHE = 'private, no-cache'

export const anatomyResponse = (answer: AnatomyAnswer): Response => {
  switch (answer._tag) {
    case 'Missing':
      return new Response('Not found\n', {
        status: 404,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      })
    case 'Broken':
      return new Response(`The anatomy catalog is unreadable: ${answer.message}\n`, {
        status: 500,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      })
    case 'NotModified':
      return new Response(null, {
        status: 304,
        headers: { etag: answer.etag, 'cache-control': CACHE },
      })
    case 'Found':
      return new Response(answer.bytes, {
        headers: {
          'content-type': answer.type,
          etag: answer.etag,
          'cache-control': CACHE,
        },
      })
  }
}

// structures.json is there but cannot be read as the catalog
export class CatalogBroken extends Schema.TaggedError<CatalogBroken>()('CatalogBroken', {
  message: Schema.String,
}) {}

const CatalogJson = Schema.Record(
  Schema.String,
  Schema.Struct({
    latin: Schema.String,
    english: Schema.String,
    french: Schema.String,
    french_alt: Schema.NullOr(Schema.String),
    kind: Schema.Literals(TISSUES),
    side: Schema.Literals(SIDES),
    region: Schema.String,
  })
)
const decodeCatalog = Schema.decodeUnknownEffect(Schema.fromJsonString(CatalogJson))

// If-None-Match is a list of tags, compared weakly (RFC 9110 §13.1.2)
const matches = (ifNoneMatch: string | null, etag: string) =>
  ifNoneMatch !== null &&
  ifNoneMatch.split(',').some((tag) => tag.trim().replace(/^W\//u, '') === etag)

// A missing file is none; any other failure to read data/ is a fault
const notFound = <A>(error: PlatformError) =>
  error.reason._tag === 'NotFound' ? Effect.succeed(Option.none<A>()) : Effect.die(error)

export class Anatomy extends Context.Service<
  Anatomy,
  {
    // None: no model in DATA_DIR/anatomy
    readonly catalog: Effect.Effect<Option.Option<Catalog>, CatalogBroken>
    // Its ETag from its size and mtime; its bytes read only when the client's copy is not current;
    // structures.json only when it is the catalog
    readonly file: (file: AnatomyFile, ifNoneMatch: string | null) => Effect.Effect<AnatomyAnswer>
  }
>()('garmin/Anatomy') {
  static readonly layer = Layer.effect(
    Anatomy,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const directory = join(yield* Config.String('DATA_DIR'), 'anatomy')

      const catalog = fs.readFileString(join(directory, 'structures.json')).pipe(
        Effect.map((text) => Option.some(text)),
        Effect.catchTag('PlatformError', notFound<string>),
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.succeedNone,
            onSome: (text) =>
              decodeCatalog(text).pipe(
                Effect.map(Option.some),
                Effect.mapError((error) => new CatalogBroken({ message: error.message }))
              ),
          })
        )
      )

      const file = Effect.fn('Anatomy.file')(function* (
        name: AnatomyFile,
        ifNoneMatch: string | null
      ) {
        const path = join(directory, name)
        const info = yield* fs.stat(path).pipe(
          Effect.map((stat) => Option.some(stat)),
          Effect.catchTag('PlatformError', notFound<FileSystem.File.Info>)
        )
        if (Option.isNone(info)) return { _tag: 'Missing' } as const
        const mtime = Option.match(info.value.mtime, {
          onNone: () => 0,
          onSome: (d) => d.getTime(),
        })
        const etag = `"${info.value.size}-${mtime}"`
        if (matches(ifNoneMatch, etag)) return { _tag: 'NotModified', etag } as const
        if (name === 'structures.json') {
          const broken = yield* catalog.pipe(
            Effect.as(null),
            Effect.catchTag('CatalogBroken', (error) => Effect.succeed(error.message))
          )
          if (broken !== null) return { _tag: 'Broken', message: broken } as const
        }
        // Node reads a file into a Buffer over a plain ArrayBuffer, never a shared one
        const bytes = (yield* fs.readFile(path).pipe(Effect.orDie)) as Uint8Array<ArrayBuffer>
        return { _tag: 'Found', etag, type: ANATOMY_FILES[name], bytes } as const
      })

      return Anatomy.of({ catalog, file })
    })
  )
}

// The catalog for a reader (the history, the home page): an unreadable one is logged and read as
// none, the names then fall back to the ids
export const readableCatalog = (anatomy: {
  readonly catalog: Effect.Effect<Option.Option<Catalog>, CatalogBroken>
}): Effect.Effect<Catalog | null> =>
  anatomy.catalog.pipe(
    Effect.map(Option.getOrNull),
    Effect.catchTag('CatalogBroken', (error) =>
      Effect.logWarning('anatomy: structures.json unreadable', error.message).pipe(Effect.as(null))
    )
  )
