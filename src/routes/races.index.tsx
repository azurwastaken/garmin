import { createFileRoute, Link } from '@tanstack/react-router'
import { Effect, Schema } from 'effect'

import { api } from '#src/api/client.ts'
import { readForm, seeOther } from '#src/auth.ts'
import { duration, fmt, longDay } from '#src/components/format.ts'
import { FactsInputSchema } from '#src/races/race.ts'
import { Races } from '#src/races/races.ts'
import { runtime } from '#src/server/runtime.ts'

// The races being prepared, and the upload of a new one's GPX (a multipart POST to this page: the
// file in data/races/, then its page)

const MAX_GPX = 20 * 1024 * 1024

const ERRORS = {
  size: 'Fichier trop gros : 20 Mo au plus.',
  fields: 'Il faut un nom (avec au moins une lettre ou un chiffre), une date et un fichier GPX.',
  gpx: 'Ce fichier n’est pas un GPX lisible.',
  exists: 'Une course de ce nom cette année existe déjà.',
  terrain: 'Le GPX n’a pas d’altitudes et les tuiles d’élévation n’ont pas répondu : réessaie.',
} as const
type UploadError = keyof typeof ERRORS

const upload = async (request: Request) => {
  const back = (error: UploadError, detail?: string) =>
    seeOther(
      `/races?error=${error}${detail === undefined ? '' : `&detail=${encodeURIComponent(detail.slice(0, 200))}`}`
    )
  const form = await readForm(request, MAX_GPX + 64 * 1024)
  if (form instanceof Response) return back('size')
  const file = form.file('gpx')
  const start = form('start_time')
  const facts = Schema.decodeUnknownOption(FactsInputSchema)({
    name: form('name')?.trim(),
    date: form('date'),
    ...(start === null || start === '' ? {} : { start_time: start }),
  })
  if (file === null || file.size === 0 || facts._tag === 'None') return back('fields')
  if (file.size > MAX_GPX) return back('size')
  if (!/\.gpx$/iu.test(file.name) && !/xml|gpx/iu.test(file.type)) return back('gpx')
  const gpx = await file.text()
  const outcome = await runtime.runPromise(
    Races.use((races) => races.add({ facts: facts.value, gpx })).pipe(Effect.result)
  )
  if (outcome._tag === 'Success') return seeOther(`/races/${outcome.success}`)
  const error = outcome.failure
  if (error._tag === 'TerrainError') return back('terrain', error.message)
  return back(error.reason === 'exists' ? 'exists' : 'gpx', error.message)
}

export const Route = createFileRoute('/races/')({
  // An upload's refusal (see upload), optional: the page links here without one
  validateSearch: (
    search: Record<string, unknown>
  ): { readonly error?: UploadError; readonly detail?: string } => ({
    ...(typeof search['error'] === 'string' && search['error'] in ERRORS
      ? { error: search['error'] as UploadError }
      : {}),
    ...(typeof search['detail'] === 'string' ? { detail: search['detail'] } : {}),
  }),
  loader: () => api.web.races(),
  head: () => ({ meta: [{ title: 'Garmin · préparateur de course' }] }),
  server: { handlers: { POST: ({ request }) => upload(request) } },
  component: RacesPage,
})

function RacesPage() {
  const races = Route.useLoaderData()
  const { error, detail } = Route.useSearch()
  return (
    <main className="hud">
      <p className="hud-kicker">Préparateur de course</p>
      <h1>Objectifs</h1>
      <p className="sub">
        Le parcours (GPX), ses segments, la prévision d’après tes sorties, et le plan à discuter
        avec Claude (outils MCP <code>get_race</code>, <code>plan_race</code>).
      </p>

      <section className="hud-panel">
        <h2 className="hud-title">Courses</h2>
        {races.length === 0 ? (
          <p className="note">Pas encore de course : dépose un GPX ci-dessous.</p>
        ) : (
          <div className="table-wrap">
            <table className="hud-table">
              <thead>
                <tr>
                  <th>Course</th>
                  <th>Date</th>
                  <th className="num">Distance</th>
                  <th className="num">D+ / D−</th>
                  <th className="num">km-effort</th>
                  <th className="num">Prévision</th>
                  <th>Plan</th>
                </tr>
              </thead>
              <tbody>
                {races.map((race) =>
                  race._tag === 'Broken' ? (
                    <tr key={race.slug}>
                      <td>{race.slug}</td>
                      <td colSpan={6} className="error">
                        {race.problem}
                      </td>
                    </tr>
                  ) : (
                    <tr key={race.slug}>
                      <td>
                        <Link to="/races/$slug" params={{ slug: race.slug }}>
                          {race.name}
                        </Link>
                      </td>
                      <td>{longDay(race.date)}</td>
                      <td className="num">{fmt(race.km, 1)} km</td>
                      <td className="num">
                        {fmt(race.d_plus)} / {fmt(race.d_minus)} m
                      </td>
                      <td className="num">{fmt(race.km_effort, 1)}</td>
                      <td className="num">{duration(race.predicted_s)}</td>
                      <td>{race.planned ? 'écrit' : '–'}</td>
                    </tr>
                  )
                )}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="hud-panel">
        <h2 className="hud-title">Nouvelle course</h2>
        <form className="stack" method="post" action="/races" encType="multipart/form-data">
          <label>
            Nom
            <input name="name" required maxLength={120} placeholder="Trail des Aiguilles Rouges" />
          </label>
          <label>
            Date
            <input name="date" type="date" required />
          </label>
          <label>
            Heure de départ (facultatif)
            <input name="start_time" type="time" />
          </label>
          <label>
            Fichier GPX (20 Mo au plus)
            <input
              name="gpx"
              type="file"
              accept=".gpx,application/gpx+xml,application/xml"
              required
            />
          </label>
          {error === undefined ? null : (
            <div className="error" role="alert">
              {ERRORS[error]}
              {detail === undefined ? null : ` (${detail})`}
            </div>
          )}
          <button className="primary" type="submit">
            Ajouter
          </button>
        </form>
        <p className="note muted">
          Les ravitaillements et les barrières horaires s’ajoutent avec Claude (
          <code>add_race</code> avec le slug de la course).
        </p>
      </section>
    </main>
  )
}
