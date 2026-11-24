import { createFileRoute, Link } from '@tanstack/react-router'

import { api } from '#src/api/client.ts'
import { INSIGHT_MIN_DAYS, SLEEP_PERIODS } from '#src/api/periods.ts'
import {
  LineChart,
  RangeColumns,
  SegmentedBar,
  StackedColumns,
  shortDay,
} from '#src/components/charts.tsx'
import { clock, dayLabel, fmt, hours, longDay, numericDay } from '#src/components/format.ts'
import { STAGES, stageParts } from '#src/components/parts.ts'
import type {
  BedtimeBucket,
  DurationBucket,
  Measured,
  Plan,
  Regularity,
  SleepInsights,
  Spread,
  Tags,
} from '#src/sleep-insights.ts'
import type { SleepAverages, SleepNight } from '#src/stats.ts'

// Sleep: the last night in detail (its stages, its HRV against Garmin's baseline), the period's
// averages against the period before, what the nights say (the window, tonight, recovery by
// bedtime and by duration, regularity, the tagged nights), the stages and the schedule night by
// night, the score, HRV, resting HR and body battery at wake time
type Period = (typeof SLEEP_PERIODS)[number]

export const Route = createFileRoute('/sleep')({
  // ?days= is optional: 30 by default
  validateSearch: (search: Record<string, unknown>): { days?: Period } => {
    const asked = search['days']
    const days = SLEEP_PERIODS.find(
      (period) => period === asked || (typeof period === 'number' && period === Number(asked))
    )
    return days === undefined || days === 30 ? {} : { days }
  },
  loaderDeps: ({ search }) => ({ days: search.days ?? 30 }),
  loader: ({ deps }) => api.web.sleep({ days: deps.days }),
  head: () => ({ meta: [{ title: 'Garmin · sommeil' }] }),
  component: Sleep,
})

const PERIOD_LABEL: Record<Period, string> = {
  30: '30 nuits',
  90: '90 nuits',
  365: '1 an',
  all: 'Tout',
}
const AVERAGE_LABEL: Record<Period, string> = {
  30: '30 nuits',
  90: '90 nuits',
  365: '1 an',
  all: 'tout l’historique',
}
// Nothing before the whole history: no comparison
const BEFORE_LABEL: Record<Period, string | null> = {
  30: 'aux 30 nuits d’avant',
  90: 'aux 90 nuits d’avant',
  365: 'à l’année d’avant',
  all: null,
}

// Past 120 nights, a column per night is too thin: a column per week, its nights' average
interface Column {
  readonly key: string
  readonly label: string
  readonly deep_s: number
  readonly light_s: number
  readonly rem_s: number
  readonly awake_s: number
  readonly bed_min: number | null
  readonly wake_min: number | null
  // From falling asleep to waking, by the timestamps (a DST night is an hour off the clock)
  readonly span_min: number | null
}

const average = (values: ReadonlyArray<number | null>) => {
  const known = values.filter((value): value is number => value !== null)
  return known.length === 0 ? null : known.reduce((a, b) => a + b, 0) / known.length
}

const span = (night: SleepNight) =>
  night.sleep_start === null || night.sleep_end === null
    ? null
    : (Date.parse(night.sleep_end) - Date.parse(night.sleep_start)) / 60_000

const columns = (nights: ReadonlyArray<SleepNight>, weekly: boolean): Array<Column> => {
  if (!weekly) {
    return nights.map((night) => ({
      key: night.day,
      label: `Nuit du ${dayLabel(night.day)}`,
      deep_s: night.deep_s ?? 0,
      light_s: night.light_s ?? 0,
      rem_s: night.rem_s ?? 0,
      awake_s: night.awake_s ?? 0,
      bed_min: night.bed_min,
      wake_min: night.wake_min,
      span_min: span(night),
    }))
  }
  const weeks = new Map<string, Array<SleepNight>>()
  for (const night of nights) {
    const date = new Date(`${night.day}T00:00:00Z`)
    date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7))
    const monday = date.toISOString().slice(0, 10)
    const week = weeks.get(monday)
    if (week === undefined) weeks.set(monday, [night])
    else week.push(night)
  }
  return [...weeks].map(([monday, week]) => {
    const slept = week.filter((night) => night.sleep_s !== null)
    return {
      key: monday,
      label: `Semaine du ${shortDay(monday)} (moyenne de ${slept.length} nuit${slept.length > 1 ? 's' : ''})`,
      deep_s: average(slept.map((night) => night.deep_s)) ?? 0,
      light_s: average(slept.map((night) => night.light_s)) ?? 0,
      rem_s: average(slept.map((night) => night.rem_s)) ?? 0,
      awake_s: average(slept.map((night) => night.awake_s)) ?? 0,
      bed_min: average(slept.map((night) => night.bed_min)),
      wake_min: average(slept.map((night) => night.wake_min)),
      span_min: average(slept.map((night) => span(night))),
    }
  })
}

const STAGE_SERIES = STAGES.map((stage) => ({
  key: stage.key,
  label: stage.label,
  color: stage.color,
  value: (column: Column) => column[`${stage.key}_s`] / 3600,
}))

const HRV_STATUS: Record<string, string> = {
  BALANCED: 'équilibrée',
  UNBALANCED: 'déséquilibrée',
  LOW: 'basse',
  POOR: 'faible',
  NONE: '–',
}

function Change({
  now,
  before,
  format,
  same = 0.5,
}: {
  readonly now: number | null
  readonly before: number | null
  readonly format: (value: number) => string
  // Under this difference, the two are the same (half a point; 30 s for a duration)
  readonly same?: number
}) {
  if (now === null || before === null) return <div className="delta">–</div>
  const diff = now - before
  if (Math.abs(diff) < same) return <div className="delta">= la période d'avant</div>
  return (
    <div className="delta">
      {diff > 0 ? '▲' : '▼'} {format(Math.abs(diff))} vs la période d'avant
    </div>
  )
}

function Averages({
  now,
  before,
}: {
  readonly now: SleepAverages
  readonly before: SleepAverages
}) {
  return (
    <div className="grid cols-4">
      <div className="card tile">
        <div className="label">Durée moyenne</div>
        <div className="value">{hours(now.sleep_s)}</div>
        <Change now={now.sleep_s} before={before.sleep_s} format={(v) => hours(v)} same={30} />
      </div>
      <div className="card tile">
        <div className="label">Score moyen</div>
        <div className="value">
          {fmt(now.sleep_score)}
          <small>/ 100</small>
        </div>
        <Change now={now.sleep_score} before={before.sleep_score} format={(v) => fmt(v)} />
      </div>
      <div className="card tile">
        <div className="label">Coucher · lever moyens</div>
        <div className="value">
          {now.bed_min === null ? '–' : clock(now.bed_min)}
          <small>→ {now.wake_min === null ? '–' : clock(now.wake_min)}</small>
        </div>
        <div className="delta">
          {now.bed_spread_min === null
            ? '–'
            : `coucher à ± ${fmt(now.bed_spread_min)} min près${now.bed_spread_min <= 30 ? ', régulier' : ''}`}
        </div>
      </div>
      <div className="card tile">
        <div className="label">Profond · paradoxal</div>
        <div className="value">
          {fmt(now.deep_pct)}
          <small>%</small> · {fmt(now.rem_pct)}
          <small>%</small>
        </div>
        <div className="delta">du temps endormi · {fmt(now.nights)} nuits mesurées</div>
      </div>
    </div>
  )
}

// A mean ± its 95 % interval, or a dash under 5 nights
function MeasuredCell({ value }: { readonly value: Measured }) {
  if (value.kind === 'few') return <td className="num muted">–</td>
  return (
    <td className="num" style={{ whiteSpace: 'nowrap' }}>
      {fmt(value.mean, 1)} <small className="muted">± {fmt(value.ci95, 1)}</small>
    </td>
  )
}

// Each bucket's nights and recovery, a dash where there are under 5 nights
function BucketTable({
  rows,
  label,
  mark,
}: {
  readonly rows: ReadonlyArray<BedtimeBucket | DurationBucket>
  readonly label: string
  // The row to flag (the plateau), by its label
  readonly mark?: string
}) {
  return (
    <div className="table-wrap">
      <table aria-label={label}>
        <thead>
          <tr>
            <th>Tranche</th>
            <th className="num">Nuits</th>
            <th className="num">Score</th>
            <th className="num">HRV</th>
            <th className="num">FC repos</th>
            <th className="num">Body battery</th>
            <th className="num">Readiness</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.label}>
              <td>
                {row.label}
                {row.label === mark ? <b> · plateau</b> : null}
              </td>
              <td className="num">
                {row.nights}
                {row.nights > 0 && row.recovery.score.kind === 'few' ? (
                  <small className="muted"> trop peu</small>
                ) : null}
              </td>
              <MeasuredCell value={row.recovery.score} />
              <MeasuredCell value={row.recovery.hrv} />
              <MeasuredCell value={row.recovery.resting_hr} />
              <MeasuredCell value={row.recovery.body_battery} />
              <MeasuredCell value={row.recovery.readiness} />
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// The window, big, and why
function WindowCard({ plan }: { readonly plan: Plan }) {
  if (plan.kind === 'too-few') return <p className="note muted">{plan.reason}</p>
  const { window } = plan
  return (
    <>
      <div className="label">Fenêtre conseillée</div>
      <div className="hero">
        <span>
          {clock(window.bed_min)} <small>endormi</small>
        </span>{' '}
        <span>
          {clock(window.wake_min)} <small>levé</small>
        </span>
      </div>
      <p className="note">{window.sentence}</p>
    </>
  )
}

// Signed: a deficit, or a surplus after a minus sign
const signedHours = (seconds: number) => (seconds < 0 ? `−${hours(-seconds)}` : hours(seconds))

// Tonight's bedtime, the week's debt and the sleep aimed for
function TonightFacts({ plan }: { readonly plan: Plan }) {
  if (plan.kind === 'too-few') return null
  const { tonight, debt } = plan
  return (
    <>
      <div className="facts">
        <div>
          <div className="label">Ce soir, endormi à</div>
          <div className="value">
            {clock(tonight.bed_min)}
            {tonight.earlier_min > 0 ? <small>{tonight.earlier_min} min plus tôt</small> : null}
          </div>
        </div>
        <div>
          <div className="label">Dette, 7 dernières nuits</div>
          <div className="value">
            {signedHours(debt.debt_s)}
            <small>sur {debt.nights} nuits</small>
          </div>
        </div>
        <div>
          <div className="label">Sommeil visé</div>
          <div className="value">{hours(debt.target_s)}</div>
        </div>
      </div>
      <p className="note">{tonight.sentence}</p>
    </>
  )
}

// "± 42 min", or how many nights there are under 5
const spreadText = (spread: Spread) =>
  spread.kind === 'few' ? `${spread.nights} nuits, trop peu` : `± ${spread.minutes} min`

// The spreads, the weekend's shift and each evening of the week
function RegularityTiles({ regularity }: { readonly regularity: Regularity }) {
  const jetlag = regularity.social_jetlag
  return (
    <>
      <div className="grid cols-3">
        <div className="card tile">
          <div className="label">Heure d'endormissement</div>
          <div className="value">{spreadText(regularity.bed_sd)}</div>
          <div className="delta">écart type sur {regularity.bed_sd.nights} nuits</div>
        </div>
        <div className="card tile">
          <div className="label">Heure de réveil</div>
          <div className="value">{spreadText(regularity.wake_sd)}</div>
          <div className="delta">écart type sur {regularity.wake_sd.nights} nuits</div>
        </div>
        <div className="card tile">
          <div className="label">Décalage du week-end</div>
          <div className="value">
            {jetlag.kind === 'few'
              ? '–'
              : `${jetlag.minutes < 0 ? '−' : '+'}${hours(Math.abs(jetlag.minutes) * 60)}`}
          </div>
          <div className="delta">
            {jetlag.kind === 'few'
              ? `trop peu de nuits (${jetlag.weekend} vendredis et samedis, ${jetlag.weekday} autres)`
              : `milieu de nuit des vendredis et samedis (${jetlag.weekend}) contre les autres (${jetlag.weekday})`}
          </div>
        </div>
      </div>
      <div className="card" style={{ marginTop: 14 }}>
        <div className="table-wrap">
          <table aria-label="Nuits par soir de la semaine">
            <thead>
              <tr>
                <th>Nuit du</th>
                <th className="num">Nuits</th>
                <th className="num">Endormi (médiane)</th>
                <th className="num">Score</th>
              </tr>
            </thead>
            <tbody>
              {regularity.weekdays.map((row) => (
                <tr key={row.evening}>
                  <td>{row.label}</td>
                  <td className="num">{row.nights}</td>
                  <td className="num">{row.bed_min === null ? '–' : clock(row.bed_min)}</td>
                  <MeasuredCell value={row.score} />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  )
}

const TAG_LABEL = { supplements: 'compléments', alcohol: 'alcool' } as const

// The tagged notes beside their night, and the supplements' before and after
function TaggedNights({ tags }: { readonly tags: Tags }) {
  const since = tags.supplements
  return (
    <>
      {tags.nights.length === 0 ? (
        <p className="note muted">
          Aucune note de compléments ou d'alcool : le journal (log_note) les met ici, chacune à côté
          de la nuit qui la suit.
        </p>
      ) : (
        <div className="table-wrap">
          <table aria-label="Nuits notées dans le journal">
            <thead>
              <tr>
                <th>Nuit du</th>
                <th>Note</th>
                <th className="num">Score</th>
                <th className="num">HRV</th>
                <th className="num">FC repos</th>
              </tr>
            </thead>
            <tbody>
              {tags.nights.map((tagged) => (
                <tr key={tagged.time}>
                  <td>{numericDay(tagged.night)}</td>
                  <td>
                    <b>{tagged.tags.map((tag) => TAG_LABEL[tag]).join(', ')}</b> · {tagged.text}
                  </td>
                  <td className="num">{fmt(tagged.sleep_score)}</td>
                  <td className="num">{fmt(tagged.hrv)}</td>
                  <td className="num">{fmt(tagged.resting_hr)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {since === null ? null : since.kind === 'too-few' ? (
        <p className="note">
          Compléments depuis la nuit du {numericDay(since.first_night)} : pas encore assez de nuits
          ({since.after} / {since.needed} après, {since.before} / {since.needed} avant).
        </p>
      ) : (
        <div className="table-wrap">
          <table
            aria-label={`Compléments : les nuits depuis le ${numericDay(since.first_night)} contre les 28 jours d'avant`}
          >
            <thead>
              <tr>
                <th>Compléments</th>
                <th className="num">Nuits</th>
                <th className="num">Score</th>
                <th className="num">HRV</th>
                <th className="num">FC repos</th>
              </tr>
            </thead>
            <tbody>
              {(
                [
                  ['28 jours avant', since.before],
                  [`depuis le ${numericDay(since.first_night)}`, since.after],
                ] as const
              ).map(([label, side]) => (
                <tr key={label}>
                  <td>{label}</td>
                  <td className="num">{side.nights}</td>
                  <MeasuredCell value={side.score} />
                  <MeasuredCell value={side.hrv} />
                  <MeasuredCell value={side.resting_hr} />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}

// The chart's summary for its label: each measured bucket's score and n, and the buckets with too
// few nights
const bedtimeSummary = (buckets: ReadonlyArray<BedtimeBucket>) => {
  const measured = buckets.flatMap((bucket) =>
    bucket.recovery.score.kind === 'measured'
      ? [`${bucket.label} ${fmt(bucket.recovery.score.mean, 1)} (${bucket.nights} nuits)`]
      : []
  )
  const few = buckets.filter((b) => b.nights > 0 && b.recovery.score.kind === 'few')
  return `Score de sommeil moyen selon l'heure d'endormissement : ${measured.join(', ') || 'aucune tranche de 5 nuits'}${few.length === 0 ? '' : ` ; trop peu de nuits ${few.map((b) => b.label).join(', ')}`}`
}

// What the nights say: the window, tonight, recovery by bedtime and duration, regularity, the
// tagged nights
function Insights({
  insights,
  floored,
}: {
  readonly insights: SleepInsights
  readonly floored: boolean
}) {
  const columns = insights.bedtime.flatMap((bucket) =>
    bucket.recovery.score.kind === 'measured'
      ? [
          {
            key: bucket.label,
            label: `${bucket.label} · ${bucket.nights} nuits`,
            score: bucket.recovery.score.mean,
          },
        ]
      : []
  )
  const plateau = insights.plan.kind === 'plan' ? insights.plan.window.plateau.label : undefined
  return (
    <>
      <section className="card">
        <h2>Analyse & conseils</h2>
        <p className="sub">
          Sur les {insights.nights} nuits mesurées depuis le {numericDay(insights.from)}
          {floored ? ` (l'analyse lit ${INSIGHT_MIN_DAYS} jours au moins)` : ''} · des associations,
          pas des causes
        </p>
        <WindowCard plan={insights.plan} />
        <TonightFacts plan={insights.plan} />
      </section>

      <section className="card">
        <h2>Score selon l'heure d'endormissement</h2>
        <p className="sub">Moyenne des tranches de 5 nuits ou plus · ± l'intervalle à 95 %</p>
        {columns.length === 0 ? null : (
          <StackedColumns
            rows={columns}
            series={[
              {
                key: 'score',
                label: 'Score moyen',
                color: 'var(--series-1)',
                value: (column) => column.score,
              },
            ]}
            x={(column) => column.key}
            label={(column) => column.label}
            tick={(column) => column.key}
            unit="/ 100"
            title={bedtimeSummary(insights.bedtime)}
            height={180}
          />
        )}
        <BucketTable rows={insights.bedtime} label="Récupération selon l'heure d'endormissement" />
      </section>

      <section className="card">
        <h2>Score selon la durée de sommeil</h2>
        <p className="sub">
          Le plateau : au-delà, dormir plus n'est plus associé à un meilleur score
        </p>
        <BucketTable
          rows={insights.duration}
          label="Récupération selon la durée de sommeil"
          mark={plateau}
        />
      </section>

      <section>
        <h2>Régularité</h2>
        <p className="sub">Les vendredis et samedis comptés à part</p>
        <RegularityTiles regularity={insights.regularity} />
      </section>

      <section className="card">
        <h2>Nuits notées</h2>
        <p className="sub">
          Une note du jour J compte pour la nuit qui suit, finie le matin de J+1
        </p>
        <TaggedNights tags={insights.tags} />
      </section>
    </>
  )
}

function Sleep() {
  const view = Route.useLoaderData()
  const days = Route.useSearch().days ?? 30
  const night = view.last
  const weekly = view.days > 120
  const cols = columns(view.nights, weekly)
  const line = (value: (night: SleepNight) => number | null) =>
    view.nights.map((n) => ({
      key: n.day,
      label: dayLabel(n.day),
      tick: shortDay(n.day),
      value: value(n),
    }))
  const inBaseline =
    night?.hrv !== null &&
    night?.hrv !== undefined &&
    night.hrv_baseline_low !== null &&
    night.hrv_baseline_high !== null
      ? night.hrv >= night.hrv_baseline_low && night.hrv <= night.hrv_baseline_high
      : null

  return (
    <main>
      <div className="heading">
        <div>
          <h1>Sommeil</h1>
          <p className="sub">
            La nuit compte pour le jour où elle finit, comme dans Garmin Connect
          </p>
        </div>
        <nav className="periods" aria-label="Période">
          {SLEEP_PERIODS.map((period) => (
            <Link
              key={period}
              to="/sleep"
              search={period === 30 ? {} : { days: period }}
              // The selected period (the router marks its active links too, by exact search below)
              className={period === days ? 'on' : undefined}
              // The search compared whole: 30 (no ?days) is not current on ?days=90. The router
              // compares the raw URL: aria-current from the validated period (a typed ?days=30)
              activeOptions={{ exact: true, includeSearch: true }}
              aria-current={period === days ? 'page' : undefined}
            >
              {PERIOD_LABEL[period]}
            </Link>
          ))}
        </nav>
      </div>

      <section className="card" style={{ marginTop: 0 }}>
        <h2>Dernière nuit</h2>
        {night === null ? (
          <p className="note muted">
            Pas encore de nuit en base : connecte Garmin sur la page{' '}
            <Link to="/garmin">Connexion Garmin</Link>.
          </p>
        ) : (
          <>
            <p className="sub">{longDay(night.day)}</p>
            <div className="hero">{hours(night.sleep_s)}</div>
            <div className="facts">
              <div>
                <div className="label">Score</div>
                <div className="value">
                  {fmt(night.sleep_score)}
                  <small>/ 100</small>
                </div>
              </div>
              <div>
                <div className="label">Coucher → lever</div>
                <div className="value">
                  {night.bed_min === null ? '–' : clock(night.bed_min)} →{' '}
                  {night.wake_min === null ? '–' : clock(night.wake_min)}
                </div>
              </div>
              <div>
                <div className="label">HRV de la nuit</div>
                <div className="value">
                  {fmt(night.hrv)}
                  <small>ms</small>
                </div>
                <div className="note muted">
                  {night.hrv_baseline_low !== null && night.hrv_baseline_high !== null
                    ? `plage habituelle ${fmt(night.hrv_baseline_low)}–${fmt(night.hrv_baseline_high)}${inBaseline === false ? ', en dehors' : ''}`
                    : (HRV_STATUS[night.hrv_status ?? 'NONE'] ?? night.hrv_status)}
                </div>
              </div>
              <div>
                <div className="label">FC au repos</div>
                <div className="value">
                  {fmt(night.resting_hr)}
                  <small>bpm</small>
                </div>
              </div>
              <div>
                <div className="label">Respiration</div>
                <div className="value">
                  {fmt(night.respiration_avg)}
                  <small>/min</small>
                </div>
              </div>
              <div>
                <div className="label">SpO2</div>
                <div className="value">
                  {fmt(night.spo2_avg)}
                  <small>%</small>
                </div>
              </div>
              <div>
                <div className="label">Body battery au réveil</div>
                <div className="value">
                  {fmt(night.body_battery_wake)}
                  <small>/ 100</small>
                </div>
              </div>
              {night.nap_s !== null && night.nap_s > 0 ? (
                <div>
                  <div className="label">Siestes</div>
                  <div className="value">{hours(night.nap_s)}</div>
                </div>
              ) : null}
            </div>
            <div style={{ marginTop: 16 }}>
              <SegmentedBar parts={stageParts(night)} format={hours} title="Phases de la nuit" />
            </div>
          </>
        )}
      </section>

      <section>
        <h2>Moyennes, {AVERAGE_LABEL[days]}</h2>
        {BEFORE_LABEL[days] === null ? (
          <p className="sub">Depuis la première nuit mesurée</p>
        ) : (
          <p className="sub">Comparées {BEFORE_LABEL[days]}</p>
        )}
        <Averages now={view.averages} before={view.previous} />
      </section>

      <Insights insights={view.insights} floored={view.days < INSIGHT_MIN_DAYS} />

      <section className="card">
        <h2>Phases {weekly ? 'par semaine (moyenne par nuit)' : 'par nuit'} (h)</h2>
        <p className="sub">Le temps passé dans chaque phase, de bas en haut</p>
        <StackedColumns
          rows={cols}
          series={STAGE_SERIES}
          x={(column) => column.key}
          label={(column) => column.label}
          unit="h"
          title="Phases de sommeil"
        />
      </section>

      <section className="card">
        <h2>Horaires</h2>
        <p className="sub">
          De l'endormissement au réveil{weekly ? ', moyenne de chaque semaine' : ''} · le soir en
          haut
        </p>
        <RangeColumns
          rows={cols.map((column) => ({
            key: column.key,
            label: column.label,
            from: column.bed_min,
            to: column.wake_min,
            minutes: column.span_min,
          }))}
          color="var(--series-1)"
          clock={clock}
          title="Heures de coucher et de lever"
        />
      </section>

      <div className="grid cols-2" style={{ marginTop: 14 }}>
        <section className="card" style={{ marginTop: 0 }}>
          <h2>HRV (ms)</h2>
          <p className="sub">La bande : la plage habituelle selon Garmin</p>
          <LineChart
            points={view.nights.map((n) => ({
              key: n.day,
              label: dayLabel(n.day),
              tick: shortDay(n.day),
              value: n.hrv,
              lo: n.hrv_baseline_low,
              hi: n.hrv_baseline_high,
            }))}
            color="var(--series-1)"
            format={(v) => fmt(v)}
            title="HRV"
            bandLabel="plage habituelle"
            height={140}
          />
        </section>
        <section className="card" style={{ marginTop: 0 }}>
          <h2>Score de sommeil</h2>
          <p className="sub">Sur 100</p>
          <LineChart
            points={line((n) => n.sleep_score)}
            color="var(--series-1)"
            format={(v) => fmt(v)}
            title="Score"
            height={140}
          />
        </section>
        <section className="card" style={{ marginTop: 0 }}>
          <h2>FC au repos (bpm)</h2>
          <p className="sub">Plus bas, mieux récupéré</p>
          <LineChart
            points={line((n) => n.resting_hr)}
            color="var(--series-1)"
            format={(v) => fmt(v)}
            title="FC au repos"
            height={140}
          />
        </section>
        <section className="card" style={{ marginTop: 0 }}>
          <h2>Body battery au réveil</h2>
          <p className="sub">Sur 100</p>
          <LineChart
            points={line((n) => n.body_battery_wake)}
            color="var(--series-1)"
            format={(v) => fmt(v)}
            title="Body battery au réveil"
            height={140}
          />
        </section>
      </div>
    </main>
  )
}
