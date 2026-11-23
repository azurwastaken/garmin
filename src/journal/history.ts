import { type Catalog, structureLabel, structureOf, type Tissue } from '../anatomy/catalog.ts'

import type { Side } from './body-terms.ts'
import type { NoteBody } from './note.ts'

// The pains pinned on the body map over a period, without I/O (the MCP's body_history, the page's
// pins): each pin with its structure's names, and per structure and side its pain day by day

export interface BodyNote {
  readonly time: string
  readonly day: string
  readonly text: string
  readonly body: NoteBody
}

export interface Names {
  readonly french: string
  readonly english: string
  readonly latin: string
  // The French name with the note's side: "vaste latéral (quadriceps), côté droit"
  readonly label: string
}

export interface BodyPin extends BodyNote {
  // Null when the catalog does not know the structure (or is not there)
  readonly names: Names | null
  readonly tissue: Tissue | null
  readonly region: string | null
}

export interface StructureTrend {
  readonly structure: string
  readonly side: Side
  readonly names: Names | null
  readonly count: number
  readonly first_day: string
  readonly last_day: string
  readonly latest_pain: number
  readonly max_pain: number
  // The latest pain minus the first: above 0, worse
  readonly change: number
  readonly series: ReadonlyArray<{ readonly day: string; readonly pain: number }>
}

export interface BodyHistory {
  readonly from: string
  readonly to: string
  readonly pins: ReadonlyArray<BodyPin>
  // The worst now first
  readonly structures: ReadonlyArray<StructureTrend>
}

export const namesOf = (
  catalog: Catalog | null,
  body: Pick<NoteBody, 'structure' | 'side'>
): Names | null => {
  const structure = structureOf(catalog, body.structure)
  return structure === undefined
    ? null
    : {
        french: structure.french,
        english: structure.english,
        latin: structure.latin,
        label: structureLabel(structure.french, body.side),
      }
}

const trendOf = (pins: ReadonlyArray<BodyPin>): StructureTrend | null => {
  const [first] = pins
  const last = pins.at(-1)
  if (first === undefined || last === undefined) return null
  const series = pins.map((pin) => ({ day: pin.day, pain: pin.body.pain }))
  return {
    structure: first.body.structure,
    side: first.body.side,
    names: first.names,
    count: pins.length,
    first_day: first.day,
    last_day: last.day,
    latest_pain: last.body.pain,
    max_pain: Math.max(...series.map((point) => point.pain)),
    change: last.body.pain - first.body.pain,
    series,
  }
}

// `notes` in day, then time order (Tools.bodyNotes')
export const bodyHistory = (
  period: { readonly from: string; readonly to: string },
  notes: ReadonlyArray<BodyNote>,
  catalog: Catalog | null
): BodyHistory => {
  const pins = notes.map((note): BodyPin => {
    const structure = structureOf(catalog, note.body.structure)
    return {
      ...note,
      names: namesOf(catalog, note.body),
      tissue: structure?.kind ?? null,
      region: structure?.region ?? null,
    }
  })
  const structures = [
    ...Map.groupBy(pins, (pin) => `${pin.body.structure}/${pin.body.side}`).values(),
  ]
    .flatMap((group) => trendOf(group) ?? [])
    .toSorted((a, b) => b.latest_pain - a.latest_pain || b.last_day.localeCompare(a.last_day))
  return { ...period, pins, structures }
}

// Each structure's heat on the model: its highest pain, both sides together
export const heatOf = (
  trends: ReadonlyArray<Pick<StructureTrend, 'structure' | 'max_pain'>>
): ReadonlyMap<string, number> => {
  const heat = new Map<string, number>()
  for (const trend of trends) {
    heat.set(trend.structure, Math.max(heat.get(trend.structure) ?? 0, trend.max_pain))
  }
  return heat
}
