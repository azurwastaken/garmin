import { describe, expect, it } from 'vitest'

import { terrariumPng } from '../../test/races.ts'

import { AWS, decodePng, demFor, type Dem, terrainFile, terrariumAt, tileOf } from './terrarium.ts'

describe('terrarium tiles', () => {
  it('decodes every PNG filter to the altitudes encoded', () => {
    const png = terrariumPng((x, y) => 1000 + x + y / 8, { filter: (y) => y % 5 })
    const raster = decodePng(png)
    if (raster === null) throw new Error('not decoded')
    // At a pixel's centre, its own altitude
    expect(terrariumAt(raster, 10.5, 20.5)).toBeCloseTo(1012.5, 6)
    // Between four pixels, bilinear
    expect(terrariumAt(raster, 11, 21)).toBeCloseTo(1000 + 10.5 + 20.5 / 8, 6)
  })

  it('refuses another size, or what is not a PNG', () => {
    expect(decodePng(terrariumPng(() => 0, { size: 512 }))).toBeNull()
    expect(decodePng(new TextEncoder().encode('<html>Access Denied</html>'))).toBeNull()
    const png = terrariumPng(() => 0)
    expect(decodePng(png.subarray(0, 60))).toBeNull()
  })

  it('reads no altitude next to a no-data pixel', () => {
    const raster = decodePng(terrariumPng((x, y) => (x === 100 && y === 100 ? -32768 : 300)))
    if (raster === null) throw new Error('not decoded')
    expect(terrariumAt(raster, 99.6, 100.4)).toBeNull()
    expect(terrariumAt(raster, 50, 50)).toBe(300)
  })

  it('finds the tile and pixel under a point', () => {
    expect(tileOf({ lat: 0, lon: 0 }, 1)).toEqual({ x: 1, y: 1, px: 0, py: 0 })
    // Chamonix at zoom 13
    const tile = tileOf({ lat: 45.9237, lon: 6.8694 }, 13)
    expect([tile.x, tile.y]).toEqual([4252, 2916])
  })

  it('prefers a local area that holds the whole race', () => {
    const tar: Dem = {
      area: 'tar',
      tiles: '/terrain/tar/{z}/{x}/{y}.png',
      minzoom: 8,
      maxzoom: 16,
      attribution: 'IGN',
      bounds: [6.77, 45.895, 6.99, 46.035],
    }
    expect(demFor([tar], [6.8, 45.9, 6.95, 46])).toBe(tar)
    expect(demFor([tar], [6.8, 45.9, 7.1, 46])).toBe(AWS)
    expect(demFor([], [6.8, 45.9, 6.95, 46])).toBe(AWS)
  })

  it('serves only tiles.json and z/x/y.png of an area', () => {
    expect(terrainFile('paris/tiles.json')).toEqual({
      path: 'paris/tiles.json',
      type: 'application/json',
    })
    expect(terrainFile('tar/14/8504/5829.png')).toEqual({
      path: 'tar/14/8504/5829.png',
      type: 'image/png',
    })
    for (const bad of [
      '../garmin.db',
      'paris/../../garmin.db',
      '%2e%2e/garmin.db',
      'paris/%2e%2e/x.png',
      '/etc/passwd',
      'paris\\..\\x',
      'paris/12/1/1.png/../../x',
      'work/paris_l93.tif',
      'scripts/terrain.py',
      'paris/README.md',
      'paris/12/1/1.png\0',
      '',
    ]) {
      expect([bad, terrainFile(bad)]).toEqual([bad, null])
    }
  })
})
