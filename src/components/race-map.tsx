import type { GeoJSONSource } from 'maplibre-gl'
import { useEffect, useRef, useState } from 'react'

import type { Dem } from '../races/terrarium.ts'

// A race's course in 3D, on its elevation tiles (MapLibre GL, in the browser only: loaded once the
// page is there, never during server rendering). No basemap vendor, no key: a hillshade of the
// same tiles on the page's dark ground, the route colored by grade, its segment cuts, aid stations
// and cutoffs, and a flight along it (step by step when the visitor asks for less motion).

// A course point: longitude, latitude, altitude (m), metres from the start
export type TrackPoint = readonly [number, number, number, number]

export interface MapMark {
  readonly km: number
  readonly label: string
  readonly kind: 'aid' | 'cutoff'
}

type MapLibre = typeof import('maplibre-gl')
type MapInstance = InstanceType<MapLibre['Map']>

const EXAGGERATION = 1.3
// The flight: 12 s a 10 km, between 20 s and 2 min
const flightMs = (km: number) => Math.min(120_000, Math.max(20_000, km * 1200))

// A CSS token's value on the page (MapLibre takes colors, not variables)
const token = (element: Element, name: string, fallback: string) =>
  getComputedStyle(element).getPropertyValue(name).trim() || fallback

// The index of the course point nearest a position (a few thousand points: a scan is enough)
const nearest = (track: ReadonlyArray<TrackPoint>, lon: number, lat: number) => {
  const scale = Math.cos((lat * Math.PI) / 180)
  let best = 0
  let bestDistance = Number.POSITIVE_INFINITY
  for (const [i, [x, y]] of track.entries()) {
    const distance = ((x - lon) * scale) ** 2 + (y - lat) ** 2
    if (distance < bestDistance) {
      best = i
      bestDistance = distance
    }
  }
  return best
}

// The course point at a distance (km)
export const pointAt = (track: ReadonlyArray<TrackPoint>, km: number) =>
  track.findIndex((point) => point[3] >= km * 1000)

const bearing = (from: TrackPoint, to: TrackPoint) => {
  const lat1 = (from[1] * Math.PI) / 180
  const lat2 = (to[1] * Math.PI) / 180
  const dLon = ((to[0] - from[0]) * Math.PI) / 180
  const y = Math.sin(dLon) * Math.cos(lat2)
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon)
  return (Math.atan2(y, x) * 180) / Math.PI
}

// Each step of the course as a line with its grade (%), for the color
const routeOf = (track: ReadonlyArray<TrackPoint>) => ({
  type: 'FeatureCollection' as const,
  features: track.slice(1).map((point, i) => {
    const previous = track[i] ?? point
    const run = point[3] - previous[3]
    return {
      type: 'Feature' as const,
      properties: { grade: run > 0 ? (100 * (point[2] - previous[2])) / run : 0 },
      geometry: {
        type: 'LineString' as const,
        coordinates: [
          [previous[0], previous[1]],
          [point[0], point[1]],
        ],
      },
    }
  }),
})

const pointsOf = (track: ReadonlyArray<TrackPoint>, indices: ReadonlyArray<number>) => ({
  type: 'FeatureCollection' as const,
  features: indices.flatMap((i) => {
    const point = track[i]
    return point === undefined
      ? []
      : [
          {
            type: 'Feature' as const,
            properties: {},
            geometry: { type: 'Point' as const, coordinates: [point[0], point[1]] },
          },
        ]
  }),
})

export function RaceMap({
  track,
  cuts,
  marks,
  dem,
  hover,
  onHover,
}: {
  readonly track: ReadonlyArray<TrackPoint>
  // The course points where a segment starts
  readonly cuts: ReadonlyArray<number>
  readonly marks: ReadonlyArray<MapMark>
  readonly dem: Dem
  readonly hover: number | null
  readonly onHover: (index: number | null) => void
}) {
  const container = useRef<HTMLDivElement | null>(null)
  const map = useRef<MapInstance | null>(null)
  const hoverHandler = useRef(onHover)
  hoverHandler.current = onHover
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [flying, setFlying] = useState(false)
  const flight = useRef<number | null>(null)
  const step = useRef(0)

  // The map, once: rebuilt only for another course or DEM
  useEffect(() => {
    const element = container.current
    if (element === null) return
    let removed = false
    let created: MapInstance | undefined
    const start = async () => {
      const [maplibre, worker] = await Promise.all([
        import('maplibre-gl'),
        import('maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'),
      ])
      if (removed) return
      maplibre.setWorkerUrl(worker.default)
      const color = (name: string, fallback: string) => token(element, name, fallback)
      const tiles = dem.tiles.startsWith('/') ? `${window.location.origin}${dem.tiles}` : dem.tiles
      const source = {
        type: 'raster-dem' as const,
        tiles: [tiles],
        tileSize: 256,
        encoding: 'terrarium' as const,
        minzoom: dem.minzoom,
        maxzoom: dem.maxzoom,
        attribution: dem.attribution,
        ...(dem.bounds === null
          ? {}
          : { bounds: [...dem.bounds] as [number, number, number, number] }),
      }
      const lons = track.map((p) => p[0])
      const lats = track.map((p) => p[1])
      const accent = color('--accent', '#22d3ee')
      created = new maplibre.Map({
        container: element,
        maxPitch: 85,
        pitch: 62,
        bearing: -20,
        bounds: [
          [Math.min(...lons), Math.min(...lats)],
          [Math.max(...lons), Math.max(...lats)],
        ],
        fitBoundsOptions: { padding: 48 },
        attributionControl: { compact: true },
        style: {
          version: 8,
          sources: {
            dem: source,
            hillshade: source,
            route: { type: 'geojson', data: routeOf(track) },
            cuts: { type: 'geojson', data: pointsOf(track, cuts) },
            cursor: { type: 'geojson', data: pointsOf(track, []) },
          },
          layers: [
            {
              id: 'ground',
              type: 'background',
              paint: { 'background-color': color('--page', '#030a10') },
            },
            {
              id: 'relief',
              type: 'hillshade',
              source: 'hillshade',
              paint: {
                'hillshade-shadow-color': '#000000',
                'hillshade-highlight-color': color('--ink-2', '#7dd3e0'),
                'hillshade-accent-color': color('--grid', '#0e3340'),
                'hillshade-exaggeration': 0.55,
              },
            },
            {
              id: 'route-glow',
              type: 'line',
              source: 'route',
              layout: { 'line-join': 'round', 'line-cap': 'round' },
              paint: {
                'line-color': accent,
                'line-width': 12,
                'line-blur': 8,
                'line-opacity': 0.35,
              },
            },
            {
              id: 'route',
              type: 'line',
              source: 'route',
              layout: { 'line-join': 'round', 'line-cap': 'round' },
              paint: {
                'line-width': 4,
                // Down blue, flat green, up amber, steep red
                'line-color': [
                  'interpolate',
                  ['linear'],
                  ['get', 'grade'],
                  -12,
                  color('--series-1', '#3b82f6'),
                  -3,
                  color('--series-3', '#10b981'),
                  3,
                  color('--series-3', '#10b981'),
                  10,
                  color('--series-4', '#f59e0b'),
                  20,
                  color('--critical', '#ef4444'),
                ],
              },
            },
            {
              id: 'cuts',
              type: 'circle',
              source: 'cuts',
              paint: {
                'circle-radius': 4,
                'circle-color': color('--page', '#030a10'),
                'circle-stroke-color': accent,
                'circle-stroke-width': 2,
              },
            },
            {
              id: 'cursor',
              type: 'circle',
              source: 'cursor',
              paint: {
                'circle-radius': 7,
                'circle-color': accent,
                'circle-stroke-color': '#ffffff',
                'circle-stroke-width': 2,
              },
            },
          ],
          terrain: { source: 'dem', exaggeration: EXAGGERATION },
          sky: {
            'sky-color': color('--page', '#030a10'),
            'horizon-color': color('--grid', '#0e3340'),
            'fog-color': color('--page', '#030a10'),
            'sky-horizon-blend': 0.6,
            'horizon-fog-blend': 0.7,
            'fog-ground-blend': 0.75,
            'atmosphere-blend': 0.6,
          },
        },
      })
      created.addControl(new maplibre.NavigationControl({ visualizePitch: true }), 'top-right')
      created.addControl(
        new maplibre.TerrainControl({ source: 'dem', exaggeration: EXAGGERATION }),
        'top-right'
      )
      created.addControl(new maplibre.FullscreenControl(), 'top-right')
      for (const mark of marks) {
        const point = track[Math.max(0, pointAt(track, mark.km))]
        if (point === undefined) continue
        const label = document.createElement('div')
        label.className = `race-marker ${mark.kind}`
        label.textContent = mark.label
        new maplibre.Marker({ element: label, anchor: 'bottom' })
          .setLngLat([point[0], point[1]])
          .addTo(created)
      }
      const live = created
      live.on('mousemove', 'route', (event) => {
        hoverHandler.current(nearest(track, event.lngLat.lng, event.lngLat.lat))
      })
      live.on('mouseleave', 'route', () => hoverHandler.current(null))
      live.on('load', () => setState('ready'))
      live.on('error', (event) => console.warn('race map', event.error))
      map.current = live
    }
    start().catch((error: unknown) => {
      console.warn('race map', error)
      setState('failed')
    })
    return () => {
      removed = true
      if (flight.current !== null) cancelAnimationFrame(flight.current)
      created?.remove()
      map.current = null
    }
  }, [track, cuts, marks, dem])

  // The cursor where the profile (or the flight) points
  useEffect(() => {
    if (state !== 'ready') return
    void map.current
      ?.getSource<GeoJSONSource>('cursor')
      ?.setData(pointsOf(track, hover === null ? [] : [hover]))
  }, [hover, state, track])

  const stop = () => {
    if (flight.current !== null) cancelAnimationFrame(flight.current)
    flight.current = null
    setFlying(false)
  }

  // Along the course with the camera behind the runner; with less motion, one segment a press
  const fly = () => {
    const live = map.current
    if (live === null || track.length < 2) return
    const camera = (i: number) => {
      const here = track[i]
      const ahead = track[Math.min(track.length - 1, i + 12)]
      if (here === undefined || ahead === undefined) return
      live.jumpTo({
        center: [here[0], here[1]],
        bearing: bearing(here, ahead),
        pitch: 72,
        zoom: 14.2,
      })
      hoverHandler.current(i)
    }
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      camera(cuts[step.current % Math.max(1, cuts.length)] ?? 0)
      step.current += 1
      return
    }
    const km = (track.at(-1)?.[3] ?? 0) / 1000
    const duration = flightMs(km)
    const started = performance.now()
    live.once('dragstart', stop)
    setFlying(true)
    const frame = (now: number) => {
      const progress = Math.min(1, (now - started) / duration)
      camera(Math.round(progress * (track.length - 1)))
      if (progress < 1) flight.current = requestAnimationFrame(frame)
      else stop()
    }
    flight.current = requestAnimationFrame(frame)
  }

  return (
    <div className="race-map">
      <div
        ref={container}
        className="race-map-canvas"
        role="region"
        aria-label="Carte 3D du parcours : glisser pour déplacer, clic droit ou Ctrl pour incliner et tourner"
      />
      {state === 'failed' ? (
        <p className="note">
          La carte 3D n'a pas pu s'afficher (WebGL indisponible ?). Le profil et le plan restent là.
        </p>
      ) : null}
      <div className="race-map-bar">
        <button
          type="button"
          className="hud-button"
          onClick={flying ? stop : fly}
          disabled={state !== 'ready'}
        >
          {flying ? '■ Stop' : '▶ Survoler le parcours'}
        </button>
        <span className="hud-legend" aria-hidden="true">
          <i style={{ background: 'var(--series-1)' }} /> descente
          <i style={{ background: 'var(--series-3)' }} /> plat
          <i style={{ background: 'var(--series-4)' }} /> montée
          <i style={{ background: 'var(--critical)' }} /> raide
        </span>
      </div>
    </div>
  )
}
