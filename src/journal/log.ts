import { join } from 'node:path'

import {
  Clock,
  Config,
  Context,
  Effect,
  FileSystem,
  Layer,
  Option,
  Schema,
  Semaphore,
} from 'effect'

import { Anatomy } from '../anatomy/anatomy.ts'
import { bodyMismatch } from '../anatomy/catalog.ts'
import { parisToday } from '../days.ts'
import { writeAtomic } from '../files.ts'
import { Ingest } from '../ingest.ts'

import { type JournalNote, JournalNoteJson, type NoteBody, notePath } from './note.ts'

// The journal's writer (the MCP's log_note, the body map's form): a note is checked, written to its
// own file in data/journal/, then ingested. Its file is never written over another's: two notes in
// the same millisecond take the next free one. A pinned pain is checked against the anatomy
// catalog here, when written, never at the ingest: a note once written stays readable.

// A pinned pain the anatomy model refuses (its message says why, for the caller)
export class BodyRefused extends Schema.TaggedError<BodyRefused>()('BodyRefused', {
  message: Schema.String,
}) {}

interface NoteInput {
  readonly day?: string | undefined
  readonly text: string
  readonly body?: NoteBody | undefined
}

export class Journal extends Context.Service<
  Journal,
  {
    // The note as written; its day defaults to today in Paris
    readonly log: (note: NoteInput) => Effect.Effect<JournalNote, Schema.SchemaError | BodyRefused>
  }
>()('garmin/Journal') {
  static readonly layer = Layer.effect(
    Journal,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const ingest = yield* Ingest
      const anatomy = yield* Anatomy
      const dataDir = yield* Config.String('DATA_DIR')
      const lock = yield* Semaphore.make(1)

      // The first instant from now whose file is free
      const freeTime = Effect.gen(function* () {
        let ms = yield* Clock.currentTimeMillis
        while (yield* fs.exists(join(dataDir, notePath(new Date(ms).toISOString())))) ms += 1
        return new Date(ms).toISOString()
      }).pipe(Effect.orDie)

      // The pain on the model as the catalog has it; without the model, its point only
      const checkBody = (body: NoteBody) =>
        anatomy.catalog.pipe(
          Effect.mapError(
            (error) => new BodyRefused({ message: `structures.json: ${error.message}` })
          ),
          Effect.flatMap((catalog) => {
            const refusal = bodyMismatch(body, Option.getOrNull(catalog))
            return refusal === null
              ? Effect.void
              : Effect.fail(new BodyRefused({ message: refusal }))
          })
        )

      const log = Effect.fn('Journal.log')(function* (note: NoteInput) {
        if (note.body !== undefined) yield* checkBody(note.body)
        const day = note.day ?? (yield* parisToday)
        return yield* lock.withPermits(1)(
          Effect.gen(function* () {
            const saved = yield* Schema.decodeUnknownEffect(JournalNoteJson)({
              time: yield* freeTime,
              day,
              text: note.text,
              ...(note.body === undefined ? {} : { body: note.body }),
            })
            yield* writeAtomic(fs, join(dataDir, notePath(saved.time)), JSON.stringify(saved)).pipe(
              Effect.orDie
            )
            // On disk, it is saved: the ingest every 5 minutes files it if this one fails
            yield* ingest
              .run()
              .pipe(
                Effect.catchTag('DatabaseError', (error) =>
                  Effect.logWarning('journal: note saved, its ingest deferred', error)
                )
              )
            return saved
          })
        )
      })

      return Journal.of({ log })
    })
  )
}
