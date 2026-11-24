import { createFileRoute, Link, notFound } from '@tanstack/react-router'
import mapCss from 'maplibre-gl/dist/maplibre-gl.css?url'
import { useMemo, useState } from 'react'

import { api } from '#src/api/client.ts'
import { LineChart } from '#src/components/charts.tsx'
import { duration, fmt, longDay, pace } from '#src/components/format.ts'
import { type MapMark, pointAt, RaceMap, type TrackPoint } from '#src/components/race-map.tsx'
import type { SegmentView } from '#src/races/race.ts'

// One race: its numbers, the course in 3D on its relief, the profile (one cursor with the map),
// and the plan per segment with the predicted times, the passing times and the fuelling

export const Route = createFileRoute('/races/$slug')({
  loader: async ({ params }) => {
    // A cheap guard against a URL that cannot be a race (the server checks SlugSchema itself):
    // importing it here would bring Effect's Schema and race.ts's imports into the page's bundle
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(params.slug) || params.slug.length > 64) {
      throw notFound()
    }
    const race = await api.web.race({ slug: params.slug })
    if (race === null) throw notFound()
    return race
  },
  head: ({ loaderData }) => ({
    meta: [{ title: `Garmin · ${loaderData?.view.name ?? 'course'}` }],
    links: [{ rel: 'stylesheet', href: mapCss }],
  }),
  component: () => {
    const race = Route.useLoaderData()
    return <Race key={race.view.slug} />
  },
  notFoundComponent: () => (
    <main className="hud">
      <h1>Course introuvable</h1>
      <p className="note">
        <Link to="/races">Retour aux courses</Link>
      </p>
    </main>
  ),
})

const KINDS: Record<SegmentView['kind'], string> = {
  climb: 'Montée',
  descent: 'Descente',
  flat: 'Plat',
}

// Points of the profile: one in 4 of the course's (every 100 m)
const PROFILE_EVERY = 4

function Fact({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="hud-fact">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
    </div>
  )
}

function Race() {
  const { view, track, dem, ortho, bounds } = Route.useLoaderData()
  const [hover, setHover] = useState<number | null>(null)
  const prediction = view.prediction
  const start = view.facts.start_time
  // One marker a place: an aid station and its cutoff at the same km share it
  const marks = useMemo<ReadonlyArray<MapMark>>(() => {
    const cutoffs = view.facts.cutoffs ?? []
    const aids = view.facts.aid_stations ?? []
    const at = (km: number) => (cutoff: { readonly km: number }) => Math.abs(cutoff.km - km) < 0.05
    return [
      ...aids.map((aid) => {
        const cutoff = cutoffs.find(at(aid.km))
        return {
          km: aid.km,
          label: cutoff === undefined ? aid.name : `${aid.name} ⏱ ${cutoff.time}`,
          kind: cutoff === undefined ? ('aid' as const) : ('cutoff' as const),
        }
      }),
      ...cutoffs
        .filter((cutoff) => !aids.some(at(cutoff.km)))
        .map((cutoff) => ({ km: cutoff.km, label: `⏱ ${cutoff.time}`, kind: 'cutoff' as const })),
    ]
  }, [view])
  const cuts = useMemo(
    () => view.segments.slice(1).map((s) => pointAt(track, s.from_km)),
    [view, track]
  )
  const profile = useMemo(
    () =>
      track
        .filter((_, i) => i % PROFILE_EVERY === 0 || i === track.length - 1)
        .map((point: TrackPoint) => ({
          key: String(point[3]),
          label: `km ${fmt(point[3] / 1000, 1)}`,
          tick: fmt(point[3] / 1000, 0),
          value: point[2],
        })),
    [track]
  )
  const hovered = hover === null ? undefined : track[hover]
  const hoveredKm = hovered === undefined ? null : hovered[3] / 1000
  const hoveredSegment =
    hoveredKm === null ? undefined : view.segments.find((s) => hoveredKm <= s.to_km)

  return (
    <main className="hud">
      <p className="note">
        <Link to="/races">← Courses</Link>
      </p>
      <p className="hud-kicker">
        Préparateur de course · {longDay(view.date)} {view.date.slice(0, 4)}
      </p>
      <h1>{view.name}</h1>

      <section className="hud-panel hud-facts">
        <Fact label="Distance" value={`${fmt(view.km, 1)} km`} />
        <Fact label="D+ / D−" value={`${fmt(view.d_plus)} / ${fmt(view.d_minus)} m`} />
        <Fact label="km-effort" value={fmt(view.km_effort, 1)} />
        <Fact label="Altitude" value={`${fmt(view.ele_min)}–${fmt(view.ele_max)} m`} />
        <Fact label="Départ" value={start ?? '–'} />
        <Fact label="Prévision" value={prediction === null ? '–' : duration(prediction.total_s)} />
      </section>

      <section className="hud-panel hud-map">
        <RaceMap
          track={track}
          cuts={cuts}
          marks={marks}
          dem={dem}
          ortho={ortho}
          bounds={bounds}
          hover={hover}
          onHover={setHover}
        />
        <p className="hud-readout" aria-live="polite">
          {hovered === undefined || hoveredKm === null ? (
            'Survole le profil ou le tracé'
          ) : (
            <>
              km {fmt(hoveredKm, 2)} · {fmt(hovered[2])} m
              {hoveredSegment === undefined
                ? ''
                : ` · segment ${hoveredSegment.index} (${KINDS[hoveredSegment.kind].toLowerCase()})`}
              {hovered[4] === null ? '' : ` · passage ${duration(hovered[4])}`}
            </>
          )}
        </p>
      </section>

      <section className="hud-panel">
        <h2 className="hud-title">Profil</h2>
        <LineChart
          points={profile}
          color="var(--accent)"
          format={(v) => `${fmt(v)} m`}
          title="Altitude"
          height={160}
          hover={hover === null ? null : Math.round(hover / PROFILE_EVERY)}
          onHover={(index) =>
            setHover(index === null ? null : Math.min(track.length - 1, index * PROFILE_EVERY))
          }
        />
      </section>

      <section className="hud-panel">
        <h2 className="hud-title">Plan par segment</h2>
        {prediction === null ? (
          <p className="note">
            Pas de sortie de 3 km ou plus sur l’année : pas de prévision, le plan reste lisible.
          </p>
        ) : (
          <p className="sub">
            Prévision d’après « {prediction.reference.name ?? 'ta sortie'} » du{' '}
            {longDay(prediction.reference.day)} : {fmt(prediction.reference.distance_m / 1000, 1)}{' '}
            km en {duration(prediction.reference.moving_s)} (
            {fmt(prediction.reference.equivalent_m / 1000, 1)} km à plat équivalents), étendue à la
            course (Riegel 1,06) et répartie selon la pente : la courbe de Strava, pas la tienne
            (tes sorties sont plates, rien ne la vérifie dans les pentes raides).
          </p>
        )}
        <div className="table-wrap">
          <table className="hud-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Type</th>
                <th className="num">km</th>
                <th className="num">Dist.</th>
                <th className="num">D+ / D−</th>
                <th className="num">Pente</th>
                <th className="num">km-effort</th>
                <th>Cible</th>
                <th className="num">Temps</th>
                <th className="num">Passage</th>
                <th className="num">Gels</th>
                <th className="num">Eau</th>
                <th>Notes</th>
              </tr>
            </thead>
            <tbody>
              {view.segments.map((segment, i) => {
                const timed = prediction?.segments[i]
                const plan = segment.plan
                const target = [
                  plan?.pace_s === undefined ? null : `${pace(plan.pace_s)}/km`,
                  plan?.hr === undefined ? null : `FC ${plan.hr.low}–${plan.hr.high}`,
                ].filter((part) => part !== null)
                return (
                  <tr key={segment.index} className={`seg-${segment.kind}`}>
                    <td>{segment.index}</td>
                    <td>
                      <span className={`hud-kind ${segment.kind}`}>{KINDS[segment.kind]}</span>
                    </td>
                    <td className="num">
                      {fmt(segment.from_km, 1)}–{fmt(segment.to_km, 1)}
                    </td>
                    <td className="num">{fmt(segment.km, 2)}</td>
                    <td className="num">
                      +{fmt(segment.d_plus)} / −{fmt(segment.d_minus)}
                    </td>
                    <td className="num">{fmt(segment.grade_pct, 1)} %</td>
                    <td className="num">{fmt(segment.km_effort, 1)}</td>
                    <td>{target.length === 0 ? '–' : target.join(' · ')}</td>
                    <td className="num">{duration(timed?.time_s)}</td>
                    <td className="num">
                      {timed === undefined ? '–' : (timed.clock?.end ?? duration(timed.end_s))}
                    </td>
                    <td className="num">{timed === undefined ? '–' : fmt(timed.gels)}</td>
                    <td className="num">
                      {timed === undefined ? '–' : `${fmt(timed.water_ml)} ml`}
                    </td>
                    <td className="hud-notes">
                      {[plan?.fuel, plan?.notes].filter((text) => text !== undefined).join(' — ') ||
                        '–'}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        {view.notes === null ? null : <p className="note">{view.notes}</p>}
        {view.warnings.length === 0 ? null : (
          <ul className="hud-warnings">
            {view.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        )}
      </section>

      {prediction === null ? null : (
        <div className="grid cols-2">
          <section className="hud-panel">
            <h2 className="hud-title">Ravitos et barrières</h2>
            {prediction.passings.length === 0 ? (
              <p className="note">Aucun pour l’instant (Claude peut les ajouter : add_race).</p>
            ) : (
              <table className="hud-table">
                <thead>
                  <tr>
                    <th className="num">km</th>
                    <th>Point</th>
                    <th className="num">Passage</th>
                    <th className="num">Barrière</th>
                    <th className="num">Marge</th>
                  </tr>
                </thead>
                <tbody>
                  {prediction.passings.map((passing) => (
                    <tr key={`${passing.kind}-${passing.km}`}>
                      <td className="num">{fmt(passing.km, 1)}</td>
                      <td>
                        {passing.kind === 'aid'
                          ? `${passing.name}${passing.offers === null ? '' : ` (${passing.offers})`}`
                          : `Barrière${passing.name === null ? '' : ` · ${passing.name}`}`}
                      </td>
                      <td className="num">
                        {passing.kind === 'aid'
                          ? (passing.clock ?? duration(passing.at_s))
                          : (passing.timing?.clock ?? duration(passing.at_s))}
                      </td>
                      <td className="num">{passing.kind === 'cutoff' ? passing.cutoff : ''}</td>
                      <td className="num">
                        {passing.kind === 'cutoff' && passing.timing !== null ? (
                          <span
                            className={
                              passing.timing.margin_s < 1800 ? 'status bad' : 'status good'
                            }
                          >
                            {passing.timing.margin_s < 0 ? '−' : ''}
                            {duration(Math.abs(passing.timing.margin_s))}
                          </span>
                        ) : (
                          ''
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
          <section className="hud-panel">
            <h2 className="hud-title">Ravitaillement</h2>
            <p className="sub">
              {fmt(view.fuel.carbs_g_per_h)} g de glucides par heure, gels de{' '}
              {fmt(view.fuel.gel_carbs_g)} g :{' '}
              {view.gel_every_s === null
                ? 'pas de gel'
                : `un toutes les ${fmt(view.gel_every_s / 60)} min`}{' '}
              · {fmt(view.fuel.water_ml_per_h)} ml d’eau par heure
              {view.planned ? '' : ' (par défaut, tant que le plan ne dit rien)'}.
            </p>
            <ol className="hud-gels">
              {prediction.gels.map((gel) => (
                <li key={gel.at_s}>
                  {duration(gel.at_s)} · km {fmt(gel.km, 1)}
                </li>
              ))}
            </ol>
          </section>
        </div>
      )}
    </main>
  )
}
