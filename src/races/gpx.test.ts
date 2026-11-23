import { Result } from 'effect'
import { describe, expect, it } from 'vitest'

import { gpxOf, parseGpx } from './gpx.ts'

const gpx = (body: string) => `<?xml version="1.0"?><gpx version="1.1">${body}</gpx>`
const point = (inner = '', lat = '45.9', lon = '6.8') =>
  `<trkpt lat="${lat}" lon="${lon}">${inner}</trkpt>`
const two = (inner: string) => gpx(`<trk><trkseg>${point(inner)}${point()}</trkseg></trk>`)

const ok = (xml: string) => {
  const result = parseGpx(xml)
  if (Result.isFailure(result)) throw new Error(result.failure)
  return result.success
}
const refused = (xml: string) => {
  const result = parseGpx(xml)
  return Result.isFailure(result) ? result.failure : null
}

describe('parseGpx', () => {
  it("reads a track's points in order, their altitude when there is one", () => {
    expect(
      ok(
        gpx(`<metadata><time>2027-01-01T00:00:00Z</time></metadata><trk><trkseg>
          <trkpt lat='45.9' lon="6.8"><ele>1035.5</ele><time>2027-09-25T05:00:00Z</time></trkpt>
          <trkpt lat="45.91" lon="6.81"><time>2027-09-25T04:00:00Z</time></trkpt>
          <trkpt lat="45.91" lon="6.81"><ele>
                                                                                    1040
          </ele></trkpt>
        </trkseg></trk>`)
      )
    ).toEqual([
      { lat: 45.9, lon: 6.8, ele: 1035.5 },
      { lat: 45.91, lon: 6.81, ele: null },
      // Repeated, kept here (profileOf drops it); the indentation is fine
      { lat: 45.91, lon: 6.81, ele: 1040 },
    ])
  })

  it("takes a route's points when there is no track, self-closing ones too", () => {
    expect(
      ok(
        gpx(
          `<rte><rtept lat="45.9" lon="6.8"/><rtept lat=".5" lon="6."><ele>.5</ele></rtept></rte>`
        )
      )
    ).toEqual([
      { lat: 45.9, lon: 6.8, ele: null },
      { lat: 0.5, lon: 6, ele: 0.5 },
    ])
  })

  it('reads a blank or empty altitude as missing, and ignores a waypoint’s', () => {
    expect(ok(two('<ele/>'))[0]?.ele).toBeNull()
    expect(ok(two('<ele> </ele>'))[0]?.ele).toBeNull()
    expect(
      ok(
        gpx(
          `<wpt lat="45" lon="6"><ele>900</ele><name>Ravito</name></wpt><trk>${point()}${point('<ele>8849</ele>')}</trk>`
        )
      )
    ).toEqual([
      { lat: 45.9, lon: 6.8, ele: null },
      { lat: 45.9, lon: 6.8, ele: 8849 },
    ])
  })

  it('ignores what comments and CDATA hold', () => {
    expect(
      ok(gpx(`<!-- ${point()} --><![CDATA[${point()}]]><trk>${point()}${point()}</trk>`))
    ).toHaveLength(2)
  })

  it('refuses a hostile or broken file with its reason', () => {
    const cases: Array<[string, string]> = [
      ['<!DOCTYPE gpx [<!ENTITY a "aaaa">]>' + two(''), 'DOCTYPE ou ENTITY refusés'],
      [`<trk>${point()}${point()}</trk>`, "pas un fichier GPX (pas d'élément <gpx>)"],
      [gpx(`<!-- ${point()}`), 'un commentaire ou un CDATA non fermé'],
      [gpx(point()), 'moins de 2 points de trace (trkpt) ou de route (rtept)'],
      [two('<ele>0x10</ele>'), 'une altitude illisible (0x10)'],
      [two('<ele>812.5abc</ele>'), 'une altitude illisible (812.5abc)'],
      [two(`<ele>${'1'.repeat(70)}</ele>`), 'une altitude trop longue'],
      [two('<ele>1e308</ele>'), 'altitude hors limites'],
      [two('<ele>-1e308</ele>'), 'altitude hors limites'],
      [two('<ele>Infinity</ele>'), 'une altitude illisible (Infinity)'],
      [two('<ele>812</ele><ele>813</ele>'), 'deux altitudes pour un point'],
      [gpx(`<trk>${point('', '91')}${point()}</trk>`), 'un point hors du globe'],
      [gpx(`<trk>${point('', 'north')}${point()}</trk>`), 'un point sans lat/lon lisibles'],
      [
        gpx(`<trk><trkpt lat="1" lon="1">${point()}</trkpt></trk>`),
        'un <trkpt> dans un autre point',
      ],
      [gpx(`<trk>${point()}<trkpt lat="1" lon="1"><ele>3</ele></trk>`), 'un <trkpt> non fermé'],
      [
        gpx(`<trk>${point()}${point()}<trkpt lat="1" lon="1" ${'x'.repeat(2000)}></trkpt></trk>`),
        'un </trkpt> sans ouverture',
      ],
      [
        gpx(`<trk>${point()}${point()}<trkpt lat="1" lon="1" ${'x'.repeat(2000)}/></trk>`),
        'un point illisible',
      ],
    ]
    for (const [xml, reason] of cases)
      expect([xml.slice(0, 60), refused(xml)]).toEqual([xml.slice(0, 60), reason])
  })

  it('stays linear on 20 MB of junk', () => {
    for (const junk of ['<trkpt ', '<!--', '<ele>', 'a'.repeat(7)]) {
      const xml = `<gpx>${junk.repeat(Math.floor((20 * 1024 * 1024) / junk.length))}`
      const started = performance.now()
      expect(refused(xml)).not.toBeNull()
      expect(performance.now() - started).toBeLessThan(1000)
    }
  })

  it('reads back what gpxOf writes', () => {
    const points = [
      { lat: 45.9234567, lon: 6.8712345, ele: 1035.4 },
      { lat: 45.9334567, lon: 6.8812345, ele: -12.5 },
    ]
    expect(ok(gpxOf(points))).toEqual(points)
  })
})
