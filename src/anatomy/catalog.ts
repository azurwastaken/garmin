import { type Side, SIDE_LABEL } from '../journal/body-terms.ts'
import type { NoteBody } from '../journal/note.ts'

// The anatomy model's catalog (data/anatomy/structures.json, see its README.md), without I/O and
// without Effect, for the server and the browser alike: the names of a structure, the layers the
// body map peels, the search, the checks of a pinned pain, its colour and size

export const TISSUES = [
  'bone',
  'muscle',
  'tendon',
  'ligament',
  'fascia',
  'cartilage',
  'bursa',
  'fat_pad',
] as const
export type Tissue = (typeof TISSUES)[number]

export interface Structure {
  readonly latin: string
  readonly english: string
  readonly french: string
  // The other common French term, often the older one
  readonly french_alt: string | null
  readonly kind: Tissue
  readonly side: Side
  readonly region: string
}

// By the model's mesh names (e.g. vastus_lateralis_r)
export type Catalog = Readonly<Record<string, Structure>>

export type BodyPoint = NonNullable<NoteBody['point']>

// The catalog's own entry for an id (never an inherited key like `constructor`)
export const structureOf = (catalog: Catalog | null, id: string): Structure | undefined =>
  catalog !== null && Object.hasOwn(catalog, id) ? catalog[id] : undefined

// The model's bounding box (VERIFY.txt: x ±0.161, y −0.003…1.271, z −0.135…0.114) and 5 cm
// around it: a point outside was not clicked on the model
export const MODEL_BOUNDS = { min: [-0.21, -0.05, -0.19], max: [0.21, 1.32, 0.17] } as const

// What the map peels, from the surface in: the IT band, the gluteus maximus, the thoracolumbar
// fascia and the abdominal wall cover the deeper targets
export type Layer = 'surface' | 'muscle' | 'tendon' | 'ligament' | 'bone'
export const LAYERS: ReadonlyArray<{
  readonly id: Layer
  readonly label: string
  readonly kinds: ReadonlyArray<Tissue>
}> = [
  { id: 'surface', label: 'Fascias et bourses', kinds: ['fascia', 'bursa', 'fat_pad'] },
  { id: 'muscle', label: 'Muscles', kinds: ['muscle'] },
  { id: 'tendon', label: 'Tendons', kinds: ['tendon'] },
  { id: 'ligament', label: 'Ligaments et cartilages', kinds: ['ligament', 'cartilage'] },
  { id: 'bone', label: 'Os', kinds: ['bone'] },
]

export type SideFilter = 'both' | 'left' | 'right'

// "vaste latéral (quadriceps), côté droit": the side the note says (a midline structure has one too)
export const structureLabel = (french: string, side: Side) =>
  side === 'midline' ? french : `${french}, ${SIDE_LABEL[side]}`

export const isShown = (
  structure: Pick<Structure, 'kind' | 'side'>,
  layers: ReadonlySet<Layer>,
  side: SideFilter
) =>
  LAYERS.some((layer) => layers.has(layer.id) && layer.kinds.includes(structure.kind)) &&
  (side === 'both' || structure.side === 'midline' || structure.side === side)

// Lowercase, without accents: 'Vaste latéral' → 'vaste lateral'
const fold = (text: string) => text.normalize('NFD').replaceAll(/\p{M}/gu, '').toLowerCase()

const words = (text: string) =>
  fold(text)
    .split(/[^a-z0-9]+/u)
    .filter(Boolean)

// What a structure is found by: its id (underscores as spaces) and its names
const haystack = (id: string, names: Pick<Structure, 'french' | 'french_alt' | 'english'>) =>
  fold([id.replaceAll('_', ' '), names.french, names.french_alt ?? '', names.english].join(' | '))

// The shown structures with every word of the query, by French name
export const searchStructures = (
  catalog: Catalog,
  query: string,
  shown: (id: string) => boolean
): Array<[string, Structure]> => {
  const wanted = words(query)
  return Object.entries(catalog)
    .filter(([id, structure]) => {
      const text = haystack(id, structure)
      return shown(id) && wanted.every((word) => text.includes(word))
    })
    .toSorted(([, a], [, b]) => a.french.localeCompare(b.french, 'fr'))
}

const SIDE_WORDS = new Set(['l', 'r', 'left', 'right', 'gauche', 'droit', 'droite'])

// The ids nearest an unknown one, for its refusal: its words but a side, each entry ranked by how
// many it holds, then on the asked side first, then by fewer id words the query does not name
export const closestIds = (catalog: Catalog, id: string, side: Side): ReadonlyArray<string> => {
  const wanted = words(id.replaceAll('_', ' ')).filter((word) => !SIDE_WORDS.has(word))
  return Object.entries(catalog)
    .map(([key, structure]) => {
      const text = haystack(key, structure)
      return {
        key,
        matched: wanted.filter((word) => text.includes(word)).length,
        onSide: structure.side === side ? 0 : 1,
        unmatched: key.split('_').filter((word) => !wanted.includes(word)).length,
      }
    })
    .filter((entry) => entry.matched > 0)
    .toSorted((a, b) => b.matched - a.matched || a.onSide - b.onSide || a.unmatched - b.unmatched)
    .slice(0, 3)
    .map((entry) => entry.key)
}

const inside = (point: BodyPoint) =>
  point.every(
    (value, axis) =>
      value >= (MODEL_BOUNDS.min[axis] ?? 0) && value <= (MODEL_BOUNDS.max[axis] ?? 0)
  )

// Why a pinned pain cannot be written, or null: its point off the model; with the catalog, an
// unknown structure (with the nearest ids) or a side not the structure's
export const bodyMismatch = (
  body: { readonly structure: string; readonly side: Side; readonly point?: BodyPoint },
  catalog: Catalog | null
): string | null => {
  if (body.point !== undefined && !inside(body.point)) {
    return `The point ${JSON.stringify(body.point)} is outside the anatomy model.`
  }
  if (catalog === null) return null
  const structure = structureOf(catalog, body.structure)
  if (structure === undefined) {
    const closest = closestIds(catalog, body.structure, body.side)
    return `Unknown structure "${body.structure}"${closest.length === 0 ? '' : `; closest: ${closest.join(', ')}`}.`
  }
  if (structure.side !== 'midline' && structure.side !== body.side) {
    return `${body.structure} is on the ${structure.side} side, not ${body.side}.`
  }
  return null
}

// A pain's colour and size, on the model and in the lists: 0–3, 4–6, 7–10
export type PainLevel = 'low' | 'mid' | 'high'
export const painLevel = (pain: number): PainLevel =>
  pain <= 3 ? 'low' : pain <= 6 ? 'mid' : 'high'
export const PAIN_COLOR_VAR = {
  low: '--good',
  mid: '--warning-ink',
  high: '--critical',
} as const satisfies Record<PainLevel, `--${string}`>
// Metres: 6 mm at 0, 18 mm at 10
export const pinRadius = (pain: number) => 0.006 + pain * 0.0012

// The 3D scene's colours, from the sheet's variables (the HUD: a dark stage, the model glows)
export interface ScenePalette {
  // The canvas' background
  readonly stage: string
  readonly base: string
  // Hovered and selected structures
  readonly highlight: string
  readonly pain: Record<PainLevel, string>
}

export const readPalette = (style: Pick<CSSStyleDeclaration, 'getPropertyValue'>): ScenePalette => {
  const read = (name: string) => style.getPropertyValue(name).trim()
  return {
    stage: read('--page'),
    base: read('--accent'),
    highlight: read('--ink'),
    pain: {
      low: read(PAIN_COLOR_VAR.low),
      mid: read(PAIN_COLOR_VAR.mid),
      high: read(PAIN_COLOR_VAR.high),
    },
  }
}
