import { createFileRoute, Link } from '@tanstack/react-router'

import { api } from '#src/api/client.ts'
import { NUTRITION_SPANS } from '#src/api/periods.ts'
import { LineChart, shortDay } from '#src/components/charts.tsx'
import { dayLabel, fmt, numericDay } from '#src/components/format.ts'
import { daysBetween } from '#src/days.ts'
import type { Classified } from '#src/nutrition/day-type.ts'
import type { NutritionView } from '#src/nutrition/nutrition.ts'
import type { DayType, NutritionPlan, Phase } from '#src/nutrition/plan.ts'
import type { Status, Trend } from '#src/nutrition/trend.ts'

// Weight and nutrition: today's target from the day's type, the weight trend against the plan
// agreed with the coach and the phase; the weigh-ins with their 7-day mean and the deficit's
// corridor, then fat and muscle. The plan is data/nutrition/plan.json (the MCP's
// set_nutrition_plan)
type Span = (typeof NUTRITION_SPANS)[number]

export const Route = createFileRoute('/nutrition')({
  // ?days= is optional: 90 by default
  validateSearch: (search: Record<string, unknown>): { days?: Span } => {
    const days = NUTRITION_SPANS.find((span) => span === Number(search['days']))
    return days === undefined || days === 90 ? {} : { days }
  },
  loaderDeps: ({ search }) => ({ span: search.days ?? 90 }),
  loader: ({ deps }) => api.web.nutrition({ span: deps.span }),
  head: () => ({ meta: [{ title: 'Garmin · poids & nutrition' }] }),
  component: Nutrition,
})

const SPAN_LABEL: Record<Span, string> = { 90: '90 jours', 365: '1 an' }

const DAY_LABEL: Record<DayType, string> = {
  rest: 'Jour de repos',
  easy: 'Jour facile',
  quality: 'Jour de qualité',
  long: 'Sortie longue',
}

const FROM_LABEL: Record<Classified['from'], string> = {
  done: 'd’après ta séance du jour',
  planned: 'd’après la séance prévue',
  nothing: 'rien au calendrier',
}

const kg = (value: number, digits = 1) => `${fmt(value, digits)} kg`
const perWeek = (value: number) => `${fmt(value, 2)} kg / semaine`

// The status as words too, never as a color alone, with the plan's own thresholds
const statusOf = (
  status: Status,
  plan: NutritionPlan
): { readonly label: string; readonly tone: 'good' | 'wait' | 'bad'; readonly advice: string } => {
  const { min, max } = plan.loss_kg_per_week
  switch (status) {
    case 'on-track':
      return {
        label: 'Dans la cible',
        tone: 'good',
        advice: `Entre ${fmt(min, 2)} et ${fmt(max, 2)} kg perdus par semaine : continue ainsi.`,
      }
    case 'too-fast':
      return {
        label: 'Perte trop rapide',
        tone: 'bad',
        advice: `Plus de ${fmt(max, 2)} kg par semaine : tu risques de perdre du muscle et de te blesser (souviens-toi de la tendinite). Mange un peu plus les jours faciles.`,
      }
    case 'slow':
      return {
        label: 'Plus lent que la cible',
        tone: 'wait',
        advice: `Moins de ${fmt(min, 2)} kg par semaine : ça avance, mais sous la cible.`,
      }
    case 'stalled':
      return {
        label: 'Stagnation',
        tone: 'wait',
        advice: `Moins de ${fmt(plan.stall_kg_per_week, 2)} kg par semaine après ${plan.stall_after_days} jours de déficit : à revoir avec le coach.`,
      }
    case 'too-few':
      return {
        label: 'Pas assez de pesées',
        tone: 'wait',
        advice:
          'Il faut au moins 4 pesées et deux semaines de moyennes sur 7 jours dans la phase pour une tendance fiable : pèse-toi le matin, plusieurs fois par semaine.',
      }
    case 'maintenance':
      return {
        label: 'Maintien',
        tone: 'good',
        advice: 'Phase de maintien : le poids doit rester stable.',
      }
    case 'no-phase':
      return {
        label: 'Hors plan',
        tone: 'wait',
        advice: 'Aucune phase du plan ne couvre aujourd’hui.',
      }
  }
}

const trendLine = (trend: Trend) =>
  trend.kind === 'measured'
    ? `${trend.kg_per_week > 0 ? '+' : ''}${perWeek(trend.kg_per_week)}`
    : 'pas assez de pesées'

function TargetCard({ view }: { view: NutritionView }) {
  const { day, target } = view
  return (
    <div className="card tile">
      <div className="label">Cible du jour · {DAY_LABEL[day.type]}</div>
      <div className="value">
        {fmt(target.kcal)}
        <small>kcal</small>
      </div>
      <p className="note">
        {fmt(target.protein_g)} g de protéines
        {target.run_carbs_g_per_h === null
          ? null
          : ` · pendant la sortie : ${fmt(target.run_carbs_g_per_h.min)} à ${fmt(target.run_carbs_g_per_h.max)} g de glucides par heure`}
      </p>
      <p className="note muted">
        {FROM_LABEL[day.from]} : {day.reason}
      </p>
    </div>
  )
}

function TrendCard({ view }: { view: NutritionView }) {
  const { trend, latest } = view
  const status = statusOf(view.status, view.plan)
  return (
    <div className="card tile">
      <div className="label">Tendance du poids</div>
      <div className="value">
        {trend.kind === 'measured' ? (
          <>
            {trend.kg_per_week > 0 ? '+' : ''}
            {fmt(trend.kg_per_week, 2)}
            <small>kg / sem.</small>
          </>
        ) : (
          '–'
        )}
      </div>
      <span className={`status ${status.tone}`}>{status.label}</span>
      <p className="note">{status.advice}</p>
      <p className="note muted">
        Pente de la moyenne sur 7 jours du {numericDay(trend.from)} au {numericDay(trend.to)} ·{' '}
        {trend.weigh_ins} pesée{trend.weigh_ins > 1 ? 's' : ''}
      </p>
      <p className="note muted">
        {latest === null
          ? 'Aucune pesée.'
          : `Dernière pesée : ${kg(latest.weight_kg)} le ${dayLabel(latest.day)}${latest.body_fat_pct === null ? '' : ` · ${fmt(latest.body_fat_pct, 1)} % de graisse`}${latest.muscle_mass_kg === null ? '' : ` · ${kg(latest.muscle_mass_kg)} de muscle`}`}
      </p>
    </div>
  )
}

const PHASE_LABEL: Record<Phase['kind'], string> = { deficit: 'Déficit', maintenance: 'Maintien' }

const phaseLine = (phase: Phase) =>
  `${PHASE_LABEL[phase.kind]} du ${numericDay(phase.from)} au ${numericDay(phase.to)}${phase.label === undefined ? '' : ` (${phase.label})`}`

function PhaseCard({ view }: { view: NutritionView }) {
  const { phase, plan, today } = view
  const next = plan.phases.find((candidate) => candidate.from > today)
  const left = phase === null ? null : daysBetween(today, phase.to) + 1
  return (
    <div className="card tile">
      <div className="label">Phase</div>
      <div className="value">{phase === null ? 'Hors plan' : PHASE_LABEL[phase.kind]}</div>
      {phase === null ? null : (
        <p className="note">
          Jusqu’au {numericDay(phase.to)}
          {phase.label === undefined ? '' : ` · ${phase.label}`} · encore {left} jour
          {left === 1 ? '' : 's'}
        </p>
      )}
      <p className="note">
        Poids visé : environ {kg(plan.target_kg, 0)} · perte visée en déficit{' '}
        {fmt(plan.loss_kg_per_week.min, 2)} à {fmt(plan.loss_kg_per_week.max, 2)} kg / semaine
      </p>
      {next === undefined ? null : <p className="note muted">Ensuite : {phaseLine(next)}</p>}
      <p className="note muted">Plan convenu le {numericDay(plan.agreed)} avec le coach.</p>
    </div>
  )
}

function Nutrition() {
  const view = Route.useLoaderData()
  const { days, span, trend, latest } = view
  const points = (pick: (day: NutritionView['days'][number]) => number | null) =>
    days.map((day) => ({
      key: day.day,
      label: dayLabel(day.day),
      tick: shortDay(day.day),
      value: pick(day),
    }))
  const lastMean = days.findLast((day) => day.mean !== null)?.mean ?? null
  const summary = [
    `Poids sur ${SPAN_LABEL[span]}`,
    latest === null
      ? 'aucune pesée'
      : `dernière pesée ${kg(latest.weight_kg)} le ${dayLabel(latest.day)}`,
    lastMean === null ? null : `moyenne sur 7 jours ${kg(lastMean)}`,
    `tendance : ${trendLine(trend)}`,
    `statut : ${statusOf(view.status, view.plan).label}`,
  ]
    .filter((part) => part !== null)
    .join(', ')

  return (
    <main>
      <div className="heading">
        <div>
          <h1>Poids &amp; nutrition</h1>
          <p className="sub">
            La cible du jour selon ta séance, et le poids contre le plan convenu avec le coach
          </p>
        </div>
        <nav className="periods" aria-label="Période">
          {NUTRITION_SPANS.map((period) => (
            <Link
              key={period}
              to="/nutrition"
              search={period === 90 ? {} : { days: period }}
              className={period === span ? 'on' : undefined}
              activeOptions={{ exact: true, includeSearch: true }}
              aria-current={period === span ? 'page' : undefined}
            >
              {SPAN_LABEL[period]}
            </Link>
          ))}
        </nav>
      </div>

      <div className="grid cols-3">
        <TargetCard view={view} />
        <TrendCard view={view} />
        <PhaseCard view={view} />
      </div>

      <section className="card" aria-label={summary}>
        <h2>Poids (kg)</h2>
        <p className="sub">
          Chaque pesée (point), la moyenne sur 7 jours (ligne) et, en déficit, le couloir du plan :
          le poids de départ moins {fmt(view.plan.loss_kg_per_week.min, 2)} à{' '}
          {fmt(view.plan.loss_kg_per_week.max, 2)} kg par semaine
        </p>
        <LineChart
          points={days.map((day) => ({
            key: day.day,
            label: dayLabel(day.day),
            tick: shortDay(day.day),
            value: day.mean,
            reading: day.weight_kg,
            lo: day.lo,
            hi: day.hi,
          }))}
          color="var(--series-1)"
          format={(value) => fmt(value, 1)}
          title="Moyenne sur 7 jours"
          readingLabel="Pesée"
          bandLabel="Couloir du plan"
          height={220}
        />
      </section>

      <section>
        <h2>Composition</h2>
        <p className="sub">Balance Withings, une pesée par jour (la première du matin)</p>
        <div className="grid cols-2">
          <div className="card">
            <h2>Masse grasse (%)</h2>
            <LineChart
              points={points((day) => day.body_fat_pct)}
              color="var(--series-2)"
              format={(value) => fmt(value, 1)}
              title="Masse grasse"
              dots
            />
          </div>
          <div className="card">
            <h2>Masse musculaire (kg)</h2>
            <LineChart
              points={points((day) => day.muscle_mass_kg)}
              color="var(--series-3)"
              format={(value) => fmt(value, 1)}
              title="Masse musculaire"
              dots
            />
          </div>
        </div>
      </section>
    </main>
  )
}
