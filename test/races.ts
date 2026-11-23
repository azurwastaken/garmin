import { crc32, deflateSync } from 'node:zlib'

// Made-up courses and elevation tiles for the races' tests

// A straight course north out of Chamonix (45.92 N, 6.87 E), a point every 10 m, of these legs
// (metres along, metres up): its distance and D+ known exactly
export const syntheticCourse = (
  legs: ReadonlyArray<readonly [number, number]>,
  { noise = 0 }: { readonly noise?: number } = {}
) => {
  const metresPerDegree = (6_371_008.8 * Math.PI) / 180
  const points: Array<{ lat: number; lon: number; ele: number }> = []
  let d = 0
  let ele = 1035
  for (const [length, rise] of legs) {
    for (let step = 0; step < length; step += 10) {
      // A barometer's jitter, deterministic: ± noise metres
      const jitter = noise * Math.sin(points.length * 1.7)
      points.push({ lat: 45.92 + d / metresPerDegree, lon: 6.87, ele: ele + jitter })
      d += 10
      ele += (rise * 10) / length
    }
  }
  points.push({ lat: 45.92 + d / metresPerDegree, lon: 6.87, ele })
  const up = legs.reduce((sum, [, rise]) => sum + Math.max(0, rise), 0)
  const down = legs.reduce((sum, [, rise]) => sum + Math.max(0, -rise), 0)
  return { points, distance: d, up, down }
}

export const gpxText = (
  points: ReadonlyArray<{ readonly lat: number; readonly lon: number; readonly ele?: number }>
) =>
  `<?xml version="1.0"?>\n<gpx version="1.1" creator="test"><trk><name>Test</name><trkseg>\n${points
    .map(
      (p) =>
        `  <trkpt lat="${p.lat.toFixed(7)}" lon="${p.lon.toFixed(7)}">${
          p.ele === undefined ? '' : `<ele>${p.ele.toFixed(1)}</ele>`
        }<time>2027-09-25T05:00:00Z</time></trkpt>`
    )
    .join('\n')}\n</trkseg></trk></gpx>\n`

const chunk = (type: string, data: Uint8Array) => {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'latin1')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0)
  return Buffer.concat([head, data, crc])
}

// A terrarium PNG, RGB, of `size` × `size` pixels whose altitude is metres(x, y); each row with the
// filter `filter(y)` (0 none … 4 Paeth, all encoded as "none" bytes re-filtered here)
export const terrariumPng = (
  metres: (x: number, y: number) => number,
  {
    size = 256,
    filter = () => 0,
  }: { readonly size?: number; readonly filter?: (y: number) => number } = {}
) => {
  const stride = size * 3
  const pixels = new Uint8Array(size * stride)
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const value = metres(x, y) + 32768
      const i = y * stride + x * 3
      pixels[i] = Math.floor(value / 256)
      pixels[i + 1] = Math.floor(value) % 256
      pixels[i + 2] = Math.round((value % 1) * 256)
    }
  }
  const raw = new Uint8Array(size * (stride + 1))
  for (let y = 0; y < size; y += 1) {
    const kind = filter(y)
    raw[y * (stride + 1)] = kind
    for (let x = 0; x < stride; x += 1) {
      const at = y * stride + x
      const value = pixels[at] ?? 0
      const left = x >= 3 ? (pixels[at - 3] ?? 0) : 0
      const up = y > 0 ? (pixels[at - stride] ?? 0) : 0
      const corner = x >= 3 && y > 0 ? (pixels[at - stride - 3] ?? 0) : 0
      const p = left + up - corner
      const paeth =
        Math.abs(p - left) <= Math.abs(p - up) && Math.abs(p - left) <= Math.abs(p - corner)
          ? left
          : Math.abs(p - up) <= Math.abs(p - corner)
            ? up
            : corner
      const predicted = [0, left, up, (left + up) >> 1, paeth][kind] ?? 0
      raw[y * (stride + 1) + 1 + x] = (value - predicted + 256) % 256
    }
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header.set([8, 2, 0, 0, 0], 8)
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk('IHDR', header),
      chunk('IDAT', deflateSync(raw)),
      chunk('IEND', new Uint8Array()),
    ])
  )
}
