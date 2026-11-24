import { CatchBoundary, ClientOnly, createFileRoute, Link } from '@tanstack/react-router'
import { lazy, Suspense, useMemo } from 'react'

import { type Catalog, isShown, type Layer } from '#src/anatomy/catalog.ts'
import { api } from '#src/api/client.ts'
import { LineChart, StackedColumns, shortDay } from '#src/components/charts.tsx'
import { dayLabel, fmt, longDay } from '#src/components/format.ts'
import { useCatalog } from '#src/components/use-catalog.ts'
import { heatOf } from '#src/journal/history.ts'
import { doseLabel } from '#src/strength/dose.ts'
import type { Progression } from '#src/strength/history.ts'
import type { PainFlag } from '#src/strength/pain.ts'
import type { SessionPlan, Variant } from '#src/strength/program.ts'
import type { NextSession, StrengthView, WeekProposal } from '#src/strength/strength.ts'

// Strength training for a runner: the next session and how to start it on the watch, the week
// placed around the runs, the pain rule against the journal's pains, the muscles the week works on
// the body map, the sessions done and each exercise's progression, the programme of the phase.
// The programme is data/strength/program.json (the MCP's set_strength_program); schedule_strength
// pushes the week to the watch.
export const Route = createFileRoute('/renfo')({
  // ?variant=maison: the home variants; the gym by default
  validateSearch: (search: Record<string, unknown>): { variant?: 'maison' } =>
    search['variant'] === 'maison' ? { variant: 'maison' } : {},
  loaderDeps: ({ search }): { variant: Variant } => ({ variant: search.variant ?? 'gym' }),
  loader: ({ deps }) => api.web.strength({ variant: deps.variant }),
  head: () => ({ meta: [{ title: 'Garmin · renfo' }] }),
  component: Renfo,
})

// Three.js only in the browser, in its own chunk
const BodyScene = lazy(() => import('#src/components/body-scene.tsx'))

const VARIANT_LABEL: Record<Variant, string> = { gym: 'Salle', maison: 'Maison' }

// The structure's name without its side: the lists name a muscle once for both legs
const sideless = (label: string) => label.replace(/, côté (?:gauche|droit)$/u, '')
const muscles = (ids: ReadonlyArray<string>, labels: Readonly<Record<string, string>>) =>
  [...new Set(ids.map((id) => sideless(labels[id] ?? id)))].join(', ')

const WATCH_HOW =
  'Sur la montre : activité Renfo (Musculation), puis Entraînements et la séance du jour ; une séance au calendrier est aussi proposée à l’ouverture de l’activité ce jour-là. La montre compte les répétitions, corrige-les après chaque série.'

function Renfo() {
  const view = Route.useLoaderData()
  const { variant = 'gym' } = Route.useSearch()
  const phase = view.phase
  return (
    <main className="renfo-page">
      <div className="heading">
        <div>
          <h1>Renfo</h1>
          <p className="sub">
            {phase === null
              ? 'Hors phase : semaine de récupération, pas de renfo prévu'
              : `${phase.label} · du ${dayLabel(phase.from)} au ${dayLabel(phase.to)} · ${phase.note}`}
          </p>
        </div>
        <nav className="periods" aria-label="Lieu">
          {(['gym', 'maison'] as const).map((each) => (
            <Link
              key={each}
              to="/renfo"
              search={each === 'gym' ? {} : { variant: each }}
              className={each === variant ? 'on' : undefined}
              activeOptions={{ exact: true, includeSearch: true }}
              aria-current={each === variant ? 'page' : undefined}
            >
              {VARIANT_LABEL[each]}
            </Link>
          ))}
        </nav>
      </div>
      <div className="grid cols-3">
        <NextCard next={view.next} empty={view.history.total === 0} />
        <WeekCard
          title="Cette semaine"
          proposal={view.weeks[0]}
          done={view.history.weeks.at(-1)?.sessions ?? 0}
          target={view.program.sessions_per_week}
        />
        <WeekCard
          title="Semaine prochaine"
          proposal={view.weeks[1]}
          done={0}
          target={view.program.sessions_per_week}
        />
      </div>
      <PainSection view={view} />
      <BodySection view={view} />
      <HistorySection view={view} />
      <ProgramSection plans={view.plans} labels={view.labels} saved={view.saved} />
      <Evidence />
    </main>
  )
}

function NextCard({ next, empty }: { readonly next: NextSession | null; readonly empty: boolean }) {
  return (
    <div className="card">
      <h2>Prochaine séance</h2>
      {next === null ? (
        <p className="note">Aucune séance à venir dans les deux semaines.</p>
      ) : (
        <>
          <p>
            <strong>{longDay(next.day)}</strong>
            <br />
            {next.title}
          </p>
          <p className="note">
            {next.from === 'calendar'
              ? 'Au calendrier Garmin : la montre l’a à sa prochaine synchronisation.'
              : 'Proposée, pas encore sur la montre : demande à Claude de pousser la semaine (schedule_strength).'}
          </p>
        </>
      )}
      {empty ? <p className="note">{WATCH_HOW}</p> : null}
    </div>
  )
}

function WeekCard({
  title,
  proposal,
  done,
  target,
}: {
  readonly title: string
  readonly proposal: WeekProposal
  readonly done: number
  readonly target: number
}) {
  const { placement, sessions } = proposal
  return (
    <div className="card">
      <h2>
        {title} <span className="muted">· {shortDay(proposal.week)}</span>
      </h2>
      <p className="note">
        {fmt(done)} faite{done > 1 ? 's' : ''} sur {fmt(target)}
        {placement.already.length > 0
          ? ` · déjà au calendrier ou faites : ${placement.already.map(dayLabel).join(', ')}`
          : ''}
      </p>
      {sessions.length === 0 && placement.slots.length > 0 ? (
        <p className="note">Hors phase du programme : pas de séance cette semaine.</p>
      ) : null}
      <ul className="renfo-slots">
        {sessions.map((session) => (
          <li key={session.day}>
            <strong>
              {dayLabel(session.day)} · séance {session.session}
            </strong>{' '}
            {session.plan.session.name}
            <br />
            <span className="note">{session.reason}</span>
            {session.pain.length > 0 ? (
              <span className="renfo-warn">
                {' '}
                · règle des 3/10 : {session.pain.length} exercice
                {session.pain.length > 1 ? 's' : ''} à régresser
              </span>
            ) : null}
            {session.warning === null ? null : <p className="renfo-warn">{session.warning}</p>}
          </li>
        ))}
      </ul>
      {placement.missing > 0 ? (
        <p className="renfo-warn">
          {placement.missing} séance{placement.missing > 1 ? 's' : ''} sans jour possible cette
          semaine.
        </p>
      ) : null}
      {placement.rejected.length > 0 ? (
        <details>
          <summary className="note">Jours écartés ({placement.rejected.length})</summary>
          <ul className="note">
            {placement.rejected.map((rejected) => (
              <li key={rejected.day}>
                {dayLabel(rejected.day)} : {rejected.why}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  )
}

function FlagLine({
  flag,
  labels,
}: {
  readonly flag: PainFlag
  readonly labels: Readonly<Record<string, string>>
}) {
  return (
    <li>
      <strong>{flag.exercise}</strong> charge{' '}
      {flag.structures
        .map(
          (structure) =>
            `${labels[structure.structure] ?? structure.structure} (${structure.pain}/10 le ${dayLabel(structure.day)}${structure.role === 'secondary' ? ', en secondaire' : ''})`
        )
        .join(', ')}
      <br />→ {flag.regression}
    </li>
  )
}

function PainSection({ view }: { readonly view: StrengthView }) {
  const { threshold, days } = view.program.pain_rule
  return (
    <section>
      <h2>Règle des {threshold}/10</h2>
      <p className="sub">
        Une structure notée à {threshold}/10 ou plus sur la carte du corps ces {days} derniers jours
        : l’exercice qui la charge passe à sa régression.
      </p>
      <div className="grid cols-2">
        <div className="card">
          <h2>Exercices à régresser</h2>
          {view.flags.length === 0 ? (
            <p className="note">
              Aucun : rien n’est noté à {threshold}/10 ou plus sur ce qui travaille.
            </p>
          ) : (
            <ul className="renfo-flags">
              {view.flags.map((flag) => (
                <FlagLine key={flag.exercise_id} flag={flag} labels={view.labels} />
              ))}
            </ul>
          )}
        </div>
        <div className="card">
          <h2>Douleurs, {days} jours</h2>
          {view.pains.length === 0 ? (
            <p className="note">
              Aucune douleur épinglée. <Link to="/body">Carte du corps →</Link>
            </p>
          ) : (
            <ul>
              {view.pains.map((pain) => (
                <li key={pain.structure}>
                  <span className={pain.pain >= threshold ? 'renfo-warn' : undefined}>
                    {pain.pain}/10
                  </span>{' '}
                  {pain.label} · {dayLabel(pain.day)}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  )
}

const SCENE_LAYERS: ReadonlySet<Layer> = new Set(['muscle', 'tendon', 'ligament', 'bone'])

function BodySection({ view }: { readonly view: StrengthView }) {
  const catalog = useCatalog()
  const primary = view.worked.filter((w) => w.role === 'primary').map((w) => w.structure)
  const secondary = view.worked.filter((w) => w.role === 'secondary').map((w) => w.structure)
  return (
    <section>
      <h2>Ce que la semaine travaille</h2>
      <p className="sub">
        Les muscles des séances de la semaine sur le modèle, les douleurs des{' '}
        {view.program.pain_rule.days} derniers jours par-dessus.
      </p>
      <div className="body-layout">
        <div className="body-stage renfo-stage" aria-label="Modèle 3D">
          {catalog.tag === 'ready' ? (
            <Scene catalog={catalog.catalog} view={view} />
          ) : (
            <p className="note body-stage-note">
              {catalog.tag === 'loading'
                ? 'Chargement du modèle…'
                : 'Modèle anatomique absent : la liste à côté dit tout.'}
            </p>
          )}
        </div>
        <div className="card">
          <p className="renfo-legend">
            <i className="renfo-swatch primary" /> travaillé en principal{' '}
            <i className="renfo-swatch secondary" /> en secondaire{' '}
            <i className="renfo-swatch pain" /> douleur notée
          </p>
          <h2>En principal</h2>
          <p className="note">{muscles(primary, view.labels) || '—'}</p>
          <h2>En secondaire</h2>
          <p className="note">{muscles(secondary, view.labels) || '—'}</p>
        </div>
      </div>
    </section>
  )
}

function Scene({ catalog, view }: { readonly catalog: Catalog; readonly view: StrengthView }) {
  const shown = useMemo(() => {
    const visible = new Set(
      Object.entries(catalog).flatMap(([id, structure]) =>
        isShown(structure, SCENE_LAYERS, 'both') ? [id] : []
      )
    )
    return (id: string) => visible.has(id)
  }, [catalog])
  const worked = useMemo(
    () => new Map(view.worked.map((w) => [w.structure, w.role] as const)),
    [view.worked]
  )
  const heat = useMemo(
    () => heatOf(view.pains.map((pain) => ({ structure: pain.structure, max_pain: pain.pain }))),
    [view.pains]
  )
  const fallback = <p className="note body-stage-note">Chargement de la vue 3D…</p>
  return (
    <ClientOnly fallback={fallback}>
      <CatchBoundary
        getResetKey={() => 'scene'}
        errorComponent={() => (
          <p className="note body-stage-note">
            Vue 3D indisponible sur ce navigateur : la liste à côté dit tout.
          </p>
        )}
      >
        <Suspense fallback={fallback}>
          <BodyScene
            catalog={catalog}
            shown={shown}
            selected={null}
            pins={view.pins}
            heat={heat}
            worked={worked}
            onHover={() => undefined}
            onPick={() => undefined}
            onPin={() => undefined}
          />
        </Suspense>
      </CatchBoundary>
    </ClientOnly>
  )
}

// The measure that best shows an exercise's progress: the estimated 1RM, else the seconds held,
// else the reps
const measureOf = (progression: Progression) => {
  const points = progression.points
  if (points.some((point) => point.e1rm_kg !== null)) {
    return { unit: 'kg (1RM estimé)', value: (p: (typeof points)[number]) => p.e1rm_kg }
  }
  if (points.some((point) => point.seconds > 0)) {
    return { unit: 's tenues', value: (p: (typeof points)[number]) => p.seconds }
  }
  return { unit: 'répétitions', value: (p: (typeof points)[number]) => p.reps }
}

function HistorySection({ view }: { readonly view: StrengthView }) {
  const { history } = view
  if (history.total === 0) {
    return (
      <section>
        <h2>Historique</h2>
        <div className="card renfo-empty">
          <p className="hero">0</p>
          <p>
            <strong>Aucune séance de renfo enregistrée.</strong>
          </p>
          <p className="note">
            {view.next === null
              ? 'Rien de prévu pour l’instant.'
              : `Prochaine : ${longDay(view.next.day)}, ${view.next.title}.`}{' '}
            {WATCH_HOW} Chaque séance enregistrée arrive ici à la synchronisation (séries,
            répétitions, charges), avec la progression de chaque exercice.
          </p>
        </div>
      </section>
    )
  }
  return (
    <section>
      <h2>Historique</h2>
      <div className="grid cols-2">
        <div className="card">
          <StackedColumns
            rows={history.weeks}
            series={[
              {
                key: 'sessions',
                label: 'Séances',
                color: 'var(--series-1)',
                value: (week) => week.sessions,
              },
            ]}
            x={(week) => week.week}
            unit="séances"
            digits={0}
            title={`Séances par semaine, objectif ${history.target}`}
          />
        </div>
        {history.last === null ? null : (
          <div className="card">
            <h2>Dernière séance · {longDay(history.last.activity.day)}</h2>
            <p className="note">
              {history.last.activity.workout_name ?? history.last.activity.name ?? 'Renfo'}
              {history.last.activity.minutes === null
                ? ''
                : ` · ${fmt(history.last.activity.minutes)} min`}
            </p>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Exercice</th>
                    <th scope="col">Séries</th>
                  </tr>
                </thead>
                <tbody>
                  {history.last.exercises.map((exercise, index) => (
                    // A fixed list: an exercise may come back later in the session
                    <tr key={index}>
                      <td>{exercise.name}</td>
                      <td>
                        {exercise.sets
                          .map(
                            (set) =>
                              [
                                set.reps === null ? null : `${set.reps}`,
                                set.weight_kg === null ? null : `${fmt(set.weight_kg, 1)} kg`,
                                set.reps === null && set.duration_s !== null
                                  ? `${fmt(set.duration_s)} s`
                                  : null,
                              ]
                                .filter((part) => part !== null)
                                .join(' × ') || '–'
                          )
                          .join(' · ')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
      {history.progressions.length === 0 ? null : (
        <div className="grid cols-2 renfo-progress">
          {history.progressions.map((progression) => {
            const measure = measureOf(progression)
            return (
              <div className="card" key={progression.key}>
                <LineChart
                  title={`${progression.name} (${measure.unit})`}
                  color="var(--series-2)"
                  dots={progression.points.length < 3}
                  format={(value) => fmt(value, 1)}
                  points={progression.points.map((point) => ({
                    key: String(point.activity_id),
                    label: dayLabel(point.day),
                    tick: shortDay(point.day),
                    value: measure.value(point),
                  }))}
                />
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}

function ProgramSection({
  plans,
  labels,
  saved,
}: {
  readonly plans: ReadonlyArray<SessionPlan>
  readonly labels: Readonly<Record<string, string>>
  readonly saved: boolean
}) {
  return (
    <section>
      <h2>Le programme</h2>
      <p className="sub">
        {saved
          ? 'Celui convenu avec le coach (data/strength/program.json).'
          : 'Le programme par défaut du 24/11/2026 : Claude le change avec set_strength_program.'}{' '}
        {plans[0] === undefined ? '' : `Doses de la phase « ${plans[0].phase.label} ».`}
      </p>
      {plans.map((plan) => (
        <div className="card renfo-session" key={plan.session.id}>
          <h2>
            Séance {plan.session.id} · {plan.session.name}
          </h2>
          <p className="note">{plan.session.focus}</p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">Exercice</th>
                  <th scope="col">Dose</th>
                  <th scope="col">Charge</th>
                  <th scope="col">Muscles</th>
                  <th scope="col">Sur la montre</th>
                </tr>
              </thead>
              <tbody>
                {plan.exercises.map((exercise) => (
                  <tr key={exercise.id}>
                    <td>
                      <strong>{exercise.name}</strong>
                      <br />
                      <span className="note">{exercise.cue}</span>
                    </td>
                    <td>{doseLabel(exercise)}</td>
                    <td>{exercise.load}</td>
                    <td>
                      {muscles(exercise.primary, labels)}
                      <br />
                      <span className="muted">{muscles(exercise.secondary, labels)}</span>
                    </td>
                    <td>
                      <code>{exercise.garmin.exercise_name}</code>
                      {exercise.garmin.match === 'closest' ? (
                        <span className="muted"> (le plus proche du catalogue)</span>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </section>
  )
}

function Evidence() {
  return (
    <section className="renfo-evidence">
      <h2>Sur quoi il repose</h2>
      <ul className="note">
        <li>
          Le renfo lourd et la pliométrie améliorent l’économie de course : méta-analyse de
          Balsalobre-Fernández, Santos-Concejero et Grivas, <em>J Strength Cond Res</em> 2016.
        </li>
        <li>
          Le renfo lourd et lent (tempo 3-0-3) soigne la tendinopathie rotulienne aussi bien que
          l’excentrique, avec de meilleurs résultats durables : Kongsgaard et al.,{' '}
          <em>Scand J Med Sci Sports</em> 2009.
        </li>
        <li>
          Deux séances par semaine, 48 h d’écart, jamais la veille d’une séance de qualité ou de la
          sortie longue ; les jours durs durs, les jours faciles faciles.
        </li>
      </ul>
    </section>
  )
}
