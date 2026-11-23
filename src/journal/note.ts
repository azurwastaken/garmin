import { Schema } from 'effect'

import { PAIN_KINDS, PAIN_WHEN, SIDES } from './body-terms.ts'

// The user's journal, without I/O: one note per file in data/journal/YYYY/ (the source of truth, as
// every file of data/), named by the instant it was written, its key

// Its own pattern: the ingest's CLI does not load the API's
const Day = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/u))

// Metres in the anatomy model's space (Y up, origin between the feet). Loose on purpose: the
// write checks the model's bounds (anatomy/catalog.ts), so a rescaled model never makes an old
// note undecodable.
const Coordinate = Schema.Finite.check(Schema.isBetween({ minimum: -2, maximum: 2 }))

// A pain pinned on the body map (routes/body.tsx) or logged with log_note: the structure is an id
// of data/anatomy/structures.json (e.g. vastus_lateralis_r)
export const NoteBodyJson = Schema.Struct({
  structure: Schema.String.check(Schema.isPattern(/^[a-z0-9_]{1,64}$/u)),
  side: Schema.Literals(SIDES),
  // Where it was clicked on the model; none when named without the model
  point: Schema.optionalKey(Schema.Tuple([Coordinate, Coordinate, Coordinate])),
  pain: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10 })),
  kind: Schema.Literals(PAIN_KINDS),
  when: Schema.UniqueArray(Schema.Literals(PAIN_WHEN)),
  // The day it started
  since: Schema.optionalKey(Day),
})
export type NoteBody = typeof NoteBodyJson.Type

export const JournalNoteJson = Schema.Struct({
  // The ISO instant it was written
  time: Schema.String,
  // The day it is about
  day: Day,
  text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2000)),
  body: Schema.optionalKey(NoteBodyJson),
})
export type JournalNote = typeof JournalNoteJson.Type

// Its file, relative to data/ (no ':' in a file name)
export const notePath = (time: string) =>
  `journal/${time.slice(0, 4)}/${time.replaceAll(':', '-')}.json`

export const decodeNote = Schema.decodeUnknownOption(JournalNoteJson)
