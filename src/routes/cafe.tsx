import { createFileRoute } from '@tanstack/react-router'

import { api } from '#src/api/client.ts'
import type { CaffeinePage } from '#src/caffeine/caffeine.ts'
import type { CaffeineDay } from '#src/caffeine/kinetics.ts'
import type { CaffeineVsSleep, MetricGap, MetricKey } from '#src/caffeine/sleep.ts'
import { CafeCard } from '#src/components/caffeine.tsx'
import { LineChart, shortDay, StackedColumns } from '#src/components/charts.tsx'
import { clock, dayLabel, fmt } from '#src/components/format.ts'

// Caffeine: today's card, its curve in the body to bedtime, 30 days of mg and of last coffees
// against the cut-off, and the nights compared once there are enough. The mg left are estimates
// (caffeine/kinetics.ts), the comparison an association (caffeine/sleep.ts).
export const Route = createFileRoute('/cafe')({
  loader: () => api.web.caffeine(),
  head: () => ({ meta: [{ title: 'Garmin · café' }] }),
  component: Cafe,
})

// Minutes after midnight as 13:52 (format.ts's clock counts from noon)
const atMinute = (minutes: number) => clock(minutes - 720)

const DAY_SERIES = [
  { key: 'mg', label: 'Caféine', color: 'var(--series-1)', value: (day: CaffeineDay) => day.mg },
]

const METRICS: Record<MetricKey, { readonly label: string; readonly unit: string }> = {
  sleep_score: { label: 'Score de sommeil', unit: '' },
  hrv: { label: 'HRV', unit: ' ms' },
  resting_hr: { label: 'FC au repos', unit: ' bpm' },
  deep_min: { label: 'Sommeil profond', unit: ' min' },
}

const signed = (value: number, unit: string) =>
  `${value > 0 ? '+' : value < 0 ? '−' : ''}${fmt(Math.abs(value), 1)}${unit}`

function GapRow({ gap }: { readonly gap: MetricGap }) {
  const { label, unit } = METRICS[gap.key]
  if (gap.kind === 'too-few') {
    return (
      <tr>
        <td>{label}</td>
        <td colSpan={3} className="muted">
          pas assez de nuits mesurées ({gap.high_n} et {gap.low_n} sur 10)
        </td>
      </tr>
    )
  }
  return (
    <tr>
      <td>{label}</td>
      <td className="num">
        {fmt(gap.high.mean, 1)}
        {unit} <small className="muted">n={gap.high.n}</small>
      </td>
      <td className="num">
        {fmt(gap.low.mean, 1)}
        {unit} <small className="muted">n={gap.low.n}</small>
      </td>
      <td className="num">{signed(gap.diff, unit)}</td>
    </tr>
  )
}

function SleepComparison({ sleep }: { readonly sleep: CaffeineVsSleep }) {
  return (
    <section className="card">
      <h2>Caféine et sommeil</h2>
      <p className="sub">
        Les nuits avec plus de 50 mg encore dans le corps à l'endormissement (estimé au début de la
        nuit selon Garmin) contre les autres. Une association, jamais une cause. Le temps
        d'endormissement n'est pas dans les données Garmin : il n'est pas comparé.
      </p>
      {sleep.kind === 'too-few' ? (
        <p className="note">
          Pas encore assez de nuits : {sleep.high} / {sleep.needed} avec plus de 50 mg, {sleep.low}{' '}
          / {sleep.needed} avec 50 mg ou moins. Les nuits comptent à partir du surlendemain de ton
          premier café noté.
        </p>
      ) : (
        <div className="table-wrap">
          <table>
            <caption className="sr-only">
              Plus de 50 mg à l'endormissement est associé à :{' '}
              {sleep.metrics
                .flatMap((gap) =>
                  gap.kind === 'compared'
                    ? [`${METRICS[gap.key].label} ${signed(gap.diff, METRICS[gap.key].unit)}`]
                    : []
                )
                .join(', ')}
            </caption>
            <thead>
              <tr>
                <th>Mesure</th>
                <th className="num">&gt; 50 mg ({sleep.high} nuits)</th>
                <th className="num">≤ 50 mg ({sleep.low} nuits)</th>
                <th className="num">Écart</th>
              </tr>
            </thead>
            <tbody>
              {sleep.metrics.map((gap) => (
                <GapRow key={gap.key} gap={gap} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

function Cafe() {
  const page: CaffeinePage = Route.useLoaderData()
  const { today } = page
  const lastDays = page.days.filter((day) => day.last_min !== null)
  const late = lastDays.filter((day) => (day.last_min ?? 0) > page.cutoff_min).length
  return (
    <main className="cafe-page">
      <h1>Café</h1>
      <p className="sub">
        Ce que tu bois, ce qu'il en reste au coucher ({today.bedtime.clock}) et tes nuits. Les mg
        restants sont une estimation (demi-vie moyenne de 5 h selon l'EFSA 2015, entre ~2 et ~10 h
        selon les personnes), pas une mesure.
      </p>

      <div className="grid cols-2">
        <CafeCard today={today} />
        <section className="card">
          <h2>Aujourd'hui dans le corps</h2>
          <figure>
            <figcaption className="note">
              ~{fmt(today.now_mg)} mg maintenant, ~{fmt(today.bedtime_mg)} mg au coucher (
              {today.bedtime.clock}) ; la bande : 25 mg ou moins.
            </figcaption>
            <LineChart
              points={page.curve.map((point) => ({
                key: point.at,
                label: point.clock,
                tick: point.clock,
                value: point.mg,
                lo: 0,
                hi: 25,
              }))}
              color="var(--series-1)"
              format={(value) => `${fmt(value)} mg`}
              title="Caféine estimée"
              bandLabel="25 mg ou moins"
              height={160}
            />
          </figure>
        </section>
      </div>

      <section className="card">
        <h2>30 jours</h2>
        <figure>
          <figcaption className="note">
            {fmt(page.days.reduce((sum, day) => sum + day.mg, 0))} mg en 30 jours ; dernier café
            après le seuil ({atMinute(page.cutoff_min)}) {late} jour{late > 1 ? 's' : ''} sur{' '}
            {lastDays.length}.
          </figcaption>
          <StackedColumns
            rows={page.days}
            series={DAY_SERIES}
            x={(day) => day.day}
            label={(day) => dayLabel(day.day)}
            tick={(day) => shortDay(day.day)}
            unit="mg"
            title="Caféine par jour (mg)"
            digits={0}
            height={180}
          />
        </figure>
        <h3>Dernier café de la journée</h3>
        <LineChart
          dots
          points={page.days.map((day) => ({
            key: day.day,
            label: dayLabel(day.day),
            tick: shortDay(day.day),
            value: day.last_min,
            lo: page.cutoff_min,
            hi: page.bedtime_min,
          }))}
          color="var(--series-3)"
          format={atMinute}
          title="Dernière prise"
          bandLabel={`après le seuil (${atMinute(page.cutoff_min)}–${atMinute(page.bedtime_min)})`}
          height={140}
        />
      </section>

      <SleepComparison sleep={page.sleep} />
    </main>
  )
}
