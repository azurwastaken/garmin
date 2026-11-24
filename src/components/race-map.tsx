import type { GeoJSONSource, MapMovementEvent } from 'maplibre-gl'
import { useEffect, useRef, useState } from 'react'

import type { Bounds, Dem } from '../races/terrarium.ts'

import {
  followCamera,
  middle,
  type Mode,
  type Motion,
  orbitCamera,
  pressed,
  RELIEF,
  reliefStops,
  SHADING,
} from './race-scene.ts'

// A race's course in 3D, on its elevation tiles (MapLibre GL, in the browser only: loaded once the
// page is there, never during server rendering). No basemap vendor, no key: the same tiles tinted
// by altitude over the course's own range and shaded from three directions, the route colored by
// grade on a dark casing, its segment cuts, aid stations and cutoffs; a flight along it, an orbit
// around it and turns of 22.5° (step by step when the visitor asks for less motion).

// A course point: longitude, latitude, altitude (m), metres from the start, predicted seconds
export type TrackPoint = readonly [number, number, number, number, number | null]

export interface MapMark {
  readonly km: number
  readonly label: string
  readonly kind: 'aid' | 'cutoff'
}

type MapLibre = typeof import('maplibre-gl')
type MapInstance = InstanceType<MapLibre['Map']>

const EXAGGERATION = 1.3
// The tint and the shading read tiles up to z14: finer LiDAR only adds speckle
const RELIEF_MAXZOOM = 14
// A ↺/↻ press, and an Orbite press under reduced motion (°)
const TURN = 22.5
const ORBIT_STEP = 45
// The visitor's hand on the map: it stops a flight or an orbit before the next frame overrides it
const INPUTS = ['mousedown', 'touchstart', 'wheel'] as const
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

// The course point at a distance (km): the finish past it
export const pointAt = (track: ReadonlyArray<TrackPoint>, km: number) => {
  const i = track.findIndex((point) => point[3] >= km * 1000)
  return i === -1 ? track.length - 1 : i
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
  bounds,
  hover,
  onHover,
}: {
  readonly track: ReadonlyArray<TrackPoint>
  // West, south, east, north: the course's box, the first view
  readonly bounds: Bounds
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
  const [motion, setMotion] = useState<Motion>('still')
  // The next segment cut a reduced-motion flight shows
  const cut = useRef(0)

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
      const accent = color('--accent', '#22d3ee')
      const shade = color(...SHADING.shade)
      const light = color(...SHADING.light)
      created = new maplibre.Map({
        container: element,
        maxPitch: 85,
        pitch: 62,
        bearing: -20,
        bounds: [
          [bounds[0], bounds[1]],
          [bounds[2], bounds[3]],
        ],
        fitBoundsOptions: { padding: 48 },
        attributionControl: { compact: true },
        style: {
          version: 8,
          sources: {
            dem: source,
            relief: { ...source, maxzoom: Math.min(dem.maxzoom, RELIEF_MAXZOOM) },
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
              id: 'tint',
              type: 'color-relief',
              source: 'relief',
              paint: {
                'color-relief-color': [
                  'interpolate',
                  ['linear'],
                  ['elevation'],
                  ...reliefStops(
                    track.map((point) => point[2]),
                    RELIEF.map(([name, hex]) => color(name, hex))
                  ),
                ],
              },
            },
            {
              id: 'relief',
              type: 'hillshade',
              source: 'relief',
              paint: {
                // Three suns fixed on the map, north-west the strongest: no relief inverted when it turns
                'hillshade-method': 'multidirectional',
                'hillshade-illumination-anchor': 'map',
                'hillshade-illumination-direction': [270, 315, 0],
                'hillshade-illumination-altitude': [35, 45, 35],
                'hillshade-shadow-color': [shade, shade, shade],
                'hillshade-highlight-color': [light, light, light],
                'hillshade-exaggeration': 0.3,
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
              // The page's dark under every mark, so the glow and the ground never touch the grade colors
              id: 'route-casing',
              type: 'line',
              source: 'route',
              layout: { 'line-join': 'round', 'line-cap': 'round' },
              paint: { 'line-color': color('--page', '#030a10'), 'line-width': 7 },
            },
            {
              id: 'route',
              type: 'line',
              source: 'route',
              layout: { 'line-join': 'round', 'line-cap': 'round' },
              paint: {
                'line-width': 4,
                // Down, flat, up amber, steep red: the theme's series and status tokens
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
                  color('--warning-ink', '#fbbf24'),
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
        const point = track[pointAt(track, mark.km)]
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
      created?.remove()
      map.current = null
    }
  }, [track, cuts, marks, dem, bounds])

  // The cursor where the profile (or the flight) points
  useEffect(() => {
    if (state !== 'ready') return
    map.current
      ?.getSource<GeoJSONSource>('cursor')
      ?.setData(pointsOf(track, hover === null ? [] : [hover]))
      .catch((error: unknown) => console.warn('race map', error))
  }, [hover, state, track])

  // Point i of the course on the map: the camera there, the profile's cursor on it
  const follow = (live: MapInstance, i: number) => {
    const camera = followCamera(track, i)
    if (camera === null) return
    live.jumpTo(camera)
    hoverHandler.current(i)
  }

  // A frame of the orbit `elapsed` ms in: around the course's centre, never finished
  const orbitFrames = (live: MapInstance) => {
    const from = live.getCenter().toArray()
    const to = middle(bounds)
    const start = live.getBearing()
    return (elapsed: number) => {
      live.jumpTo(orbitCamera(from, to, start, elapsed))
      return false
    }
  }

  // A frame of the flight `elapsed` ms in: along the course behind the runner, finished at the end
  const flightFrames = (live: MapInstance) => {
    const duration = flightMs((track.at(-1)?.[3] ?? 0) / 1000)
    return (elapsed: number) => {
      const progress = Math.min(1, elapsed / duration)
      follow(live, Math.round(progress * (track.length - 1)))
      return progress === 1
    }
  }

  // The flight or the orbit: one frame loop, stopped at once by the visitor's own hand
  useEffect(() => {
    const live = map.current
    if (motion === 'still') return
    if (live === null) {
      setMotion('still')
      return
    }
    const advance = motion === 'orbit' ? orbitFrames(live) : flightFrames(live)
    // From the first frame's own timestamp, so never negative
    let started: number | undefined
    let id = requestAnimationFrame(function frame(now) {
      started ??= now
      if (advance(now - started)) setMotion('still')
      else id = requestAnimationFrame(frame)
    })
    const halt = () => {
      cancelAnimationFrame(id)
      setMotion('still')
    }
    // Keys, the compass and the zoom buttons move the map with their event; our own frames without
    const interrupt = (event: MapMovementEvent) => {
      if (event.originalEvent !== undefined) halt()
    }
    for (const input of INPUTS) live.on(input, halt)
    live.on('movestart', interrupt)
    return () => {
      cancelAnimationFrame(id)
      for (const input of INPUTS) live.off(input, halt)
      live.off('movestart', interrupt)
    }
  }, [motion, state, track, cuts, marks, dem, bounds])

  // A mode's step under reduced motion: the flight's next segment cut, or the orbit's next 45°
  const step = (live: MapInstance, mode: Mode) => {
    if (mode === 'flight') {
      follow(live, cuts[cut.current % Math.max(1, cuts.length)] ?? 0)
      cut.current += 1
    } else {
      live.easeTo({ center: [...middle(bounds)], bearing: live.getBearing() + ORBIT_STEP })
    }
  }

  const press = (mode: Mode) => {
    const live = map.current
    if (live === null) return
    const next = pressed(
      motion,
      mode,
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    )
    if (next === 'step') step(live, mode)
    else setMotion(next)
  }

  // A turn of `degrees`, instant under reduced motion (MapLibre's own easeTo rule)
  const turn = (degrees: number) => {
    setMotion('still')
    map.current?.easeTo({ bearing: map.current.getBearing() + degrees })
  }

  return (
    <>
      <div className="race-map">
        <div
          ref={container}
          className="race-map-canvas"
          role="region"
          aria-label="Carte 3D du parcours : glisser pour déplacer, clic droit ou Ctrl pour incliner et tourner"
        />
        {state === 'failed' ? (
          <p className="note">
            La carte 3D n'a pas pu s'afficher (WebGL indisponible ?). Le profil et le plan restent
            là.
          </p>
        ) : null}
        <div className="race-map-bar">
          <button
            type="button"
            className="hud-button"
            onClick={() => press('flight')}
            disabled={state !== 'ready' || track.length < 2}
          >
            {motion === 'flight' ? '■ Stop' : '▶ Survoler le parcours'}
          </button>
          <button
            type="button"
            className="hud-button turn"
            aria-label="Pivoter de 22,5° à gauche"
            onClick={() => turn(-TURN)}
            disabled={state !== 'ready'}
          >
            ↺
          </button>
          <button
            type="button"
            className="hud-button turn"
            aria-label="Pivoter de 22,5° à droite"
            onClick={() => turn(TURN)}
            disabled={state !== 'ready'}
          >
            ↻
          </button>
          <button
            type="button"
            className="hud-button"
            onClick={() => press('orbit')}
            disabled={state !== 'ready'}
          >
            {motion === 'orbit' ? '■ Arrêter l’orbite' : '◎ Orbite'}
          </button>
          <span className="hud-legend" aria-hidden="true">
            <i style={{ background: 'var(--series-1)' }} /> descente
            <i style={{ background: 'var(--series-3)' }} /> plat
            <i style={{ background: 'var(--warning-ink)' }} /> montée
            <i style={{ background: 'var(--critical)' }} /> raide
          </span>
        </div>
      </div>
      <p className="race-map-hint">
        Clic droit + glisser (ou Ctrl + glisser), deux doigts au tactile : pivoter et incliner · Maj
        + ← → sur la carte sélectionnée · la boussole remet le nord et à plat
      </p>
    </>
  )
}
