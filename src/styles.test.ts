import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

// The HUD stays readable: text 4.5:1 and marks 3:1 (WCAG 2) on every surface it sits on, status
// hues apart from the series (CIEDE2000), the OAuth pages on the same tokens, and motion only for
// whoever has not asked to reduce it

const css = readFileSync(new URL('styles.css', import.meta.url), 'utf8').replaceAll(
  /\/\*[\s\S]*?\*\//gu,
  ''
)
const oauth = readFileSync(new URL('oauth/http.ts', import.meta.url), 'utf8')

// The `--name: #rrggbb` pairs of a block of CSS
const tokens = (text: string): Record<string, string> =>
  Object.fromEntries(
    [...text.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})\b/giu)].map((m) => [m[1] ?? '', m[2] ?? ''])
  )
const root = tokens(css.slice(css.indexOf(':root'), css.indexOf('}', css.indexOf(':root'))))
const color = (name: string) => {
  const hex = root[name]
  if (hex === undefined) throw new Error(`no --${name} on :root`)
  return hex
}

const channels = (hex: string) =>
  [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255)
const linear = (c: number) => (c <= 0.040_45 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
const luminance = (hex: string) => {
  const [r = 0, g = 0, b = 0] = channels(hex).map((c) => linear(c))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(color(a)), luminance(color(b))].toSorted((x, y) => y - x)
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05)
}

// CIE Lab (D65), then the CIEDE2000 colour difference
const lab = (hex: string) => {
  const [r = 0, g = 0, b = 0] = channels(hex).map((c) => linear(c))
  const f = (t: number) => (t > 216 / 24_389 ? Math.cbrt(t) : (24_389 / 27 / 116) * t + 16 / 116)
  const x = f((0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.950_47)
  const y = f(0.2126 * r + 0.7152 * g + 0.0722 * b)
  const z = f((0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.088_83)
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)] as const
}
const deltaE = (a: string, b: string) => {
  const rad = Math.PI / 180
  const [L1, a1, b1] = lab(color(a))
  const [L2, a2, b2] = lab(color(b))
  const meanC = (Math.hypot(a1, b1) + Math.hypot(a2, b2)) / 2
  const G = 0.5 * (1 - Math.sqrt(meanC ** 7 / (meanC ** 7 + 25 ** 7)))
  const [ap1, ap2] = [(1 + G) * a1, (1 + G) * a2]
  const [C1, C2] = [Math.hypot(ap1, b1), Math.hypot(ap2, b2)]
  const hue = (x: number, y: number) =>
    x === 0 && y === 0 ? 0 : (Math.atan2(y, x) / rad + 360) % 360
  const [h1, h2] = [hue(ap1, b1), hue(ap2, b2)]
  let dh = h2 - h1
  if (Math.abs(dh) > 180) dh -= 360 * Math.sign(dh)
  const dH = 2 * Math.sqrt(C1 * C2) * Math.sin((dh / 2) * rad)
  const [L, C] = [(L1 + L2) / 2, (C1 + C2) / 2]
  const H = Math.abs(h1 - h2) > 180 ? (h1 + h2) / 2 + 180 : (h1 + h2) / 2
  const T =
    1 -
    0.17 * Math.cos((H - 30) * rad) +
    0.24 * Math.cos(2 * H * rad) +
    0.32 * Math.cos((3 * H + 6) * rad) -
    0.2 * Math.cos((4 * H - 63) * rad)
  const SL = 1 + (0.015 * (L - 50) ** 2) / Math.sqrt(20 + (L - 50) ** 2)
  const SC = 1 + 0.045 * C
  const SH = 1 + 0.015 * C * T
  const RT =
    -2 *
    Math.sqrt(C ** 7 / (C ** 7 + 25 ** 7)) *
    Math.sin(60 * Math.exp(-(((H - 275) / 25) ** 2)) * rad)
  const [l, c, h] = [(L2 - L1) / SL, (C2 - C1) / SC, dH / SH]
  return Math.sqrt(l ** 2 + c ** 2 + h ** 2 + RT * c * h)
}

// Every declaration of the sheet with the at-rule preludes around it
const declarations = (text: string) => {
  const found: Array<{ property: string; value: string; within: ReadonlyArray<string> }> = []
  const stack: Array<string> = []
  let start = 0
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (character === '{') {
      stack.push(text.slice(start, index).trim())
      start = index + 1
    } else if (character === ';' || character === '}') {
      const [property, ...rest] = text.slice(start, index).split(':')
      if (rest.length > 0 && property !== undefined) {
        found.push({ property: property.trim(), value: rest.join(':').trim(), within: [...stack] })
      }
      if (character === '}') stack.pop()
      start = index + 1
    }
  }
  return found
}
const outsideKeyframes = declarations(css).filter(
  (declaration) => !declaration.within.some((prelude) => prelude.startsWith('@keyframes'))
)

const TEXTS = ['ink', 'ink-2', 'muted', 'good', 'critical', 'warning-ink', 'accent']
const SURFACES = ['page', 'page-glow', 'grid-line', 'surface', 'card-top', 'card-glow']
const SERIES = ['series-1', 'series-2', 'series-3', 'series-4']
const ZONES = ['zone-1', 'zone-2', 'zone-3', 'zone-4', 'zone-5']
const STATUSES = ['good', 'critical', 'warning-ink']

describe('the HUD palette', () => {
  it('keeps text at 4.5:1 on every surface and on every fill', () => {
    for (const text of TEXTS) {
      for (const surface of SURFACES) {
        expect(contrast(text, surface), `--${text} on --${surface}`).toBeGreaterThanOrEqual(4.5)
      }
    }
    for (const fill of ['accent', ...SERIES, ...ZONES]) {
      expect(contrast(`${fill}-ink`, fill), `--${fill}-ink on --${fill}`).toBeGreaterThanOrEqual(
        4.5
      )
    }
  })

  it('keeps marks and control boundaries at 3:1', () => {
    for (const mark of [...SERIES, ...ZONES, 'ring', 'axis']) {
      for (const surface of ['surface', 'card-top', 'page']) {
        expect(contrast(mark, surface), `--${mark} on --${surface}`).toBeGreaterThanOrEqual(3)
      }
    }
    // The gauge: its arcs on their track, its ticks on the card
    for (const arc of ['series-1', 'series-3']) {
      expect(contrast(arc, 'grid'), `--${arc} on --grid`).toBeGreaterThanOrEqual(3)
    }
    expect(contrast('ink-2', 'surface')).toBeGreaterThanOrEqual(3)
  })

  it('keeps the status hues apart from the series, and the series apart', () => {
    for (const status of STATUSES) {
      for (const series of SERIES) {
        expect(deltaE(status, series), `--${status} vs --${series}`).toBeGreaterThanOrEqual(20)
      }
    }
    for (const [index, a] of SERIES.entries()) {
      for (const b of SERIES.slice(index + 1)) {
        expect(deltaE(a, b), `--${a} vs --${b}`).toBeGreaterThanOrEqual(20)
      }
    }
  })

  it('styles the OAuth pages with the same values', () => {
    const copy = tokens(oauth)
    expect(Object.keys(copy).length).toBeGreaterThan(5)
    for (const [name, hex] of Object.entries(copy)) expect(hex, `--${name}`).toBe(root[name])
  })
})

describe('the HUD motion', () => {
  it('moves only under prefers-reduced-motion: no-preference', () => {
    const moving = outsideKeyframes.filter((d) => /^(?:animation|transition)/u.test(d.property))
    expect(moving.length).toBeGreaterThan(0)
    for (const declaration of moving) {
      expect(
        declaration.within.some(
          (prelude) =>
            prelude.replaceAll(/\s/gu, '') === '@media(prefers-reduced-motion:no-preference)'
        ),
        `${declaration.property} in ${declaration.within.join(' › ')}`
      ).toBe(true)
    }
  })

  it('never hides content behind an animation', () => {
    for (const declaration of outsideKeyframes.filter((d) => d.property === 'opacity')) {
      expect(Number(declaration.value), declaration.within.join(' › ')).not.toBe(0)
    }
  })
})
