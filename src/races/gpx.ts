import { Result } from 'effect'

// A race's GPX, without I/O. The file is hostile until read: no XML parser (none expands entities
// here, and a DOCTYPE is refused anyway), one linear pass of one bounded token pattern, and a
// refusal with its reason rather than half a course.

export interface LatLon {
  readonly lat: number
  readonly lon: number
}

export interface Fix extends LatLon {
  readonly ele: number | null
}

// Plausible altitudes on Earth (Dead Sea −430 m, Everest 8 849 m): the parser's and the DEM's bound
export const ELEVATION_RANGE = { min: -500, max: 9000 } as const

// xsd:decimal with an optional exponent: no hex, no trailing junk, no Infinity
const DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u
const ELE_TEXT_MAX = 64

// The text with its comments and CDATA sections removed; null when one is never closed
const withoutComments = (xml: string): string | null => {
  let out = ''
  let at = 0
  for (;;) {
    const comment = xml.indexOf('<!--', at)
    const cdata = xml.indexOf('<![CDATA[', at)
    const next = comment === -1 ? cdata : cdata === -1 ? comment : Math.min(comment, cdata)
    if (next === -1) return out + xml.slice(at)
    const close = next === comment ? '-->' : ']]>'
    const end = xml.indexOf(close, next + 4)
    if (end === -1) return null
    out += xml.slice(at, next)
    at = end + close.length
  }
}

const attribute = (attributes: string, name: string) =>
  new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]{0,64})"|'([^']{0,64})')`, 'u').exec(attributes)

const decimal = (text: string | undefined) =>
  text !== undefined && DECIMAL.test(text.trim()) ? Number(text.trim()) : null

// A point's lat/lon, or why not
const position = (attributes: string): LatLon | string => {
  const lat = attribute(attributes, 'lat')
  const lon = attribute(attributes, 'lon')
  const latValue = decimal(lat?.[1] ?? lat?.[2])
  const lonValue = decimal(lon?.[1] ?? lon?.[2])
  if (latValue === null || lonValue === null) return 'un point sans lat/lon lisibles'
  if (Math.abs(latValue) > 90 || Math.abs(lonValue) > 180) return 'un point hors du globe'
  return { lat: latValue, lon: lonValue }
}

// An <ele>'s text as metres, null when blank, or why not
const elevation = (text: string): number | null | string => {
  const trimmed = text.trim()
  if (trimmed === '') return null
  if (trimmed.length > ELE_TEXT_MAX) return 'une altitude trop longue'
  const value = decimal(trimmed)
  if (value === null) return `une altitude illisible (${trimmed.slice(0, 16)})`
  if (value < ELEVATION_RANGE.min || value > ELEVATION_RANGE.max) return 'altitude hors limites'
  return value
}

// A tag of a point or its altitude, or a run of text (bounded: linear on any input)
const TOKEN = /<(\/?)(trkpt|rtept|ele)\b([^<>]{0,1024})>|([^<]{1,64})/gu

interface Scan {
  readonly track: Array<Fix>
  readonly route: Array<Fix>
  point: { kind: 'trkpt' | 'rtept'; at: LatLon; ele: number | null; seen: boolean } | null
  // The open <ele>'s text so far, inside a point only
  text: string | null
}

// One token into the scan; a reason when the file must be refused
const step = (scan: Scan, match: RegExpExecArray): string | null => {
  const [, closing, tag, attributes = '', text] = match
  if (text !== undefined) {
    if (scan.text !== null) {
      scan.text += text
      if (scan.text.length > ELE_TEXT_MAX * 4) return 'une altitude trop longue'
    }
    return null
  }
  if (tag === 'ele') {
    if (scan.point === null) return null
    if (closing === '/') {
      if (scan.text === null) return null
      const value = elevation(scan.text)
      if (typeof value === 'string') return value
      scan.point.ele = value
      scan.text = null
      return null
    }
    if (scan.point.seen) return 'deux altitudes pour un point'
    scan.point.seen = true
    scan.text = attributes.trimEnd().endsWith('/') ? null : ''
    return null
  }
  const kind = tag === 'trkpt' ? 'trkpt' : 'rtept'
  const points = kind === 'trkpt' ? scan.track : scan.route
  if (closing === '/') {
    if (scan.point === null || scan.point.kind !== kind) return `un </${kind}> sans ouverture`
    if (scan.text !== null) return 'une altitude non fermée'
    points.push({ ...scan.point.at, ele: scan.point.ele })
    scan.point = null
    return null
  }
  if (scan.point !== null) return `un <${kind}> dans un autre point`
  const at = position(attributes)
  if (typeof at === 'string') return at
  if (attributes.trimEnd().endsWith('/')) points.push({ ...at, ele: null })
  else scan.point = { kind, at, ele: null, seen: false }
  return null
}

// The course's points (the track's, else the route's), in the file's order: <time> is not read (a
// course's times are optional and not to be trusted); repeated points stay (profileOf drops them).
export const parseGpx = (xml: string): Result.Result<ReadonlyArray<Fix>, string> => {
  if (/<!(?:DOCTYPE|ENTITY)/iu.test(xml)) return Result.fail('DOCTYPE ou ENTITY refusés')
  const text = withoutComments(xml)
  if (text === null) return Result.fail('un commentaire ou un CDATA non fermé')
  if (!/<gpx\b/u.test(text)) return Result.fail("pas un fichier GPX (pas d'élément <gpx>)")
  const scan: Scan = { track: [], route: [], point: null, text: null }
  for (const match of text.matchAll(TOKEN)) {
    const refused = step(scan, match)
    if (refused !== null) return Result.fail(refused)
  }
  if (scan.point !== null) return Result.fail(`un <${scan.point.kind}> non fermé`)
  // A point tag the token pattern could not read (over 1024 characters, or never closed)
  const opened = text.match(/<(?:trkpt|rtept)\b/gu)?.length ?? 0
  if (opened !== scan.track.length + scan.route.length) return Result.fail('un point illisible')
  const points = scan.track.length >= 2 ? scan.track : scan.route
  return points.length >= 2
    ? Result.succeed(points)
    : Result.fail('moins de 2 points de trace (trkpt) ou de route (rtept)')
}

// A minimal GPX 1.1 of these points (altitudes from the DEM): coordinates only, no free text
export const gpxOf = (points: ReadonlyArray<LatLon & { readonly ele: number }>) =>
  [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx version="1.1" creator="garmin" xmlns="http://www.topografix.com/GPX/1/1">',
    '<trk><trkseg>',
    ...points.map(
      (p) =>
        `<trkpt lat="${p.lat.toFixed(7)}" lon="${p.lon.toFixed(7)}"><ele>${p.ele.toFixed(1)}</ele></trkpt>`
    ),
    '</trkseg></trk>',
    '</gpx>',
    '',
  ].join('\n')
