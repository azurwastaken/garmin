import { inflateSync } from 'node:zlib'

import { ELEVATION_RANGE, type LatLon } from './gpx.ts'

// Elevation tiles, without I/O: terrarium-encoded PNGs (elevation = R·256 + G + B/256 − 32768),
// the tile under a point, the DEM for a race, and the files data/terrain serves.

const SIZE = 256

export interface Raster {
  readonly width: number
  readonly height: number
  // 3 bytes a pixel
  readonly rgb: Uint8Array
}

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10]

// The chunks of a PNG: type and data
const chunks = (bytes: Uint8Array) => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const out: Array<{ type: string; data: Uint8Array }> = []
  let at = 8
  while (at + 8 <= bytes.length) {
    const length = view.getUint32(at)
    const type = String.fromCodePoint(...bytes.subarray(at + 4, at + 8))
    if (at + 12 + length > bytes.length) return null
    out.push({ type, data: bytes.subarray(at + 8, at + 8 + length) })
    at += 12 + length
  }
  return out
}

const paeth = (a: number, b: number, c: number) => {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

// The scanlines unfiltered in place (filters 0–4), `channels` bytes a pixel; false on a bad filter
const unfilter = (raw: Uint8Array, channels: number) => {
  const stride = SIZE * channels
  for (let y = 0; y < SIZE; y += 1) {
    const row = y * (stride + 1)
    const filter = raw[row]
    for (let x = 0; x < stride; x += 1) {
      const i = row + 1 + x
      const left = x >= channels ? (raw[i - channels] ?? 0) : 0
      const up = y > 0 ? (raw[i - stride - 1] ?? 0) : 0
      const corner = x >= channels && y > 0 ? (raw[i - stride - 1 - channels] ?? 0) : 0
      const value = raw[i] ?? 0
      if (filter === 1) raw[i] = value + left
      else if (filter === 2) raw[i] = value + up
      else if (filter === 3) raw[i] = value + ((left + up) >> 1)
      else if (filter === 4) raw[i] = value + paeth(left, up, corner)
      else if (filter !== 0) return false
    }
  }
  return true
}

// A 256 × 256, 8-bit RGB or RGBA, non-interlaced PNG; null for anything else, refused before inflating
export const decodePng = (bytes: Uint8Array): Raster | null => {
  if (bytes.length < 8 || SIGNATURE.some((value, i) => bytes[i] !== value)) return null
  const parts = chunks(bytes)
  const header = parts?.[0]
  if (parts === null || header?.type !== 'IHDR' || header.data.length < 13) return null
  const view = new DataView(header.data.buffer, header.data.byteOffset, 13)
  const [depth, color, , , interlace] = header.data.subarray(8, 13)
  const channels = color === 2 ? 3 : color === 6 ? 4 : 0
  if (view.getUint32(0) !== SIZE || view.getUint32(4) !== SIZE) return null
  if (depth !== 8 || channels === 0 || interlace !== 0) return null
  const idat = Buffer.concat(parts.filter((part) => part.type === 'IDAT').map((part) => part.data))
  let raw: Uint8Array
  try {
    raw = inflateSync(idat, { maxOutputLength: SIZE * (1 + SIZE * channels) })
  } catch {
    return null
  }
  if (raw.length !== SIZE * (1 + SIZE * channels) || !unfilter(raw, channels)) return null
  const rgb = new Uint8Array(SIZE * SIZE * 3)
  for (let p = 0; p < SIZE * SIZE; p += 1) {
    const from = Math.floor(p / SIZE) * (SIZE * channels + 1) + 1 + (p % SIZE) * channels
    rgb.set(raw.subarray(from, from + 3), p * 3)
  }
  return { width: SIZE, height: SIZE, rgb }
}

// The tile (x, y) at zoom z holding a point, and the point's pixel in it (Web Mercator, XYZ)
export const tileOf = (point: LatLon, z: number) => {
  const n = 2 ** z
  const lat = (Math.max(-85.0511, Math.min(85.0511, point.lat)) * Math.PI) / 180
  const fx = ((point.lon + 180) / 360) * n
  const fy = ((1 - Math.log(Math.tan(lat) + 1 / Math.cos(lat)) / Math.PI) / 2) * n
  const x = Math.min(n - 1, Math.floor(fx))
  const y = Math.min(n - 1, Math.floor(fy))
  return { x, y, px: (fx - x) * SIZE, py: (fy - y) * SIZE }
}

const metresAt = (raster: Raster, x: number, y: number) => {
  const i = (y * raster.width + x) * 3
  return (
    (raster.rgb[i] ?? 0) * 256 + (raster.rgb[i + 1] ?? 0) + (raster.rgb[i + 2] ?? 0) / 256 - 32768
  )
}

// The altitude at a pixel position, bilinear over the four pixels around it; null when one of
// them is outside ELEVATION_RANGE (no data: terrarium's floor is −32768).
// shortcut: clamped at the tile's edge (up to 1 px off at the seams, 13–19 m at the zooms used);
// read the neighbouring tile if seams ever show in a profile.
export const terrariumAt = (raster: Raster, px: number, py: number): number | null => {
  const x = Math.max(0, Math.min(raster.width - 1, px - 0.5))
  const y = Math.max(0, Math.min(raster.height - 1, py - 0.5))
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const x1 = Math.min(raster.width - 1, x0 + 1)
  const y1 = Math.min(raster.height - 1, y0 + 1)
  const corners = [
    metresAt(raster, x0, y0),
    metresAt(raster, x1, y0),
    metresAt(raster, x0, y1),
    metresAt(raster, x1, y1),
  ] as const
  if (corners.some((m) => m < ELEVATION_RANGE.min || m > ELEVATION_RANGE.max)) return null
  const fx = x - x0
  const fy = y - y0
  const [a, b, c, d] = corners
  return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy
}

export type Bounds = readonly [west: number, south: number, east: number, north: number]

// A raster-dem source as MapLibre takes it, and where the server reads its tiles
export interface Dem {
  // A local area of data/terrain, or null for AWS
  readonly area: string | null
  readonly tiles: string
  readonly minzoom: number
  readonly maxzoom: number
  readonly attribution: string
  readonly bounds: Bounds | null
}

export const AWS: Dem = {
  area: null,
  tiles: 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png',
  minzoom: 0,
  maxzoom: 15,
  attribution: '© Mapzen/AWS Terrain Tiles',
  bounds: null,
}

// West, south, east, north of points (a fold: a big GPX's points are too many to spread into Math.min)
export const boundsOf = (points: ReadonlyArray<LatLon>): Bounds =>
  points.reduce<Bounds>(
    ([w, s, e, n], p) => [
      Math.min(w, p.lon),
      Math.min(s, p.lat),
      Math.max(e, p.lon),
      Math.max(n, p.lat),
    ],
    [180, 90, -180, -90]
  )

// The first local area whose bounds hold the race's, else AWS
export const demFor = (areas: ReadonlyArray<Dem>, bbox: Bounds) =>
  areas.find(
    ({ bounds }) =>
      bounds !== null &&
      bounds[0] <= bbox[0] &&
      bounds[1] <= bbox[1] &&
      bounds[2] >= bbox[2] &&
      bounds[3] >= bbox[3]
  ) ?? AWS

// The only files served from data/terrain: <area>/tiles.json and <area>/<z>/<x>/<y>.png. Anything
// else (.., an encoded dot or slash, a backslash, an absolute path) is null.
const TERRAIN_FILE = /^([a-z0-9-]{1,32})\/(?:tiles\.json|(\d{1,2})\/(\d{1,7})\/(\d{1,7})\.png)$/u

export const terrainFile = (splat: string) => {
  const match = TERRAIN_FILE.exec(splat)
  if (match === null) return null
  return {
    path: splat,
    type: match[2] === undefined ? ('application/json' as const) : ('image/png' as const),
  }
}
