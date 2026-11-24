import { createFileRoute, Link } from '@tanstack/react-router'

import { api } from '#src/api/client.ts'
import { NUTRITION_SPANS } from '#src/api/periods.ts'
import { LineChart, shortDay } from '#src/components/charts.tsx'
import { dayLabel, fmt, numericDay } from '#src/components/format.ts'
import { daysBetween } from '#src/days.ts'
import type { Classified } from '#src/nutrition/day-type.ts'
import type { Lever, LeverKey } from '#src/nutrition/levers.ts'
import type { NutritionView } from '#src/nutrition/nutrition.ts'
import type { Goal, PeakWeight } from '#src/nutrition/peak.ts'
import type { DayType, NutritionPlan, Phase } from '#src/nutrition/plan.ts'
import type { Moment, NutrientTotal, SupplementDay } from '#src/nutrition/supplements.ts'
import {
  MIN_SLOPE_SPAN_DAYS,
  MIN_SLOPE_WEIGH_INS,
  type Status,
  type Trend,
} from '#src/nutrition/trend.ts'

// Weight and nutrition: today's target from the day's type, the weight trend against the plan
// agreed with the coach and the phase; today's supplements and their nutrients against their
// upper limits; the weigh-ins with their 7-day mean and the deficit's corridor; the peak weight
// and its levers; then fat and muscle. The plan is data/nutrition/plan.json (the MCP's
// set_nutrition_plan), the supplements data/nutrition/supplements.json (set_supplements)
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
const statusText = (
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
        advice: `Il faut au moins ${MIN_SLOPE_WEIGH_INS} pesées et ${MIN_SLOPE_SPAN_DAYS} jours de moyennes sur 7 jours dans la phase pour une tendance fiable : pèse-toi le matin, plusieurs fois par semaine.`,
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
  const status = statusText(view.status, view.plan)
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

// --- The supplements

const MOMENT_LABEL: Record<Moment, string> = {
  breakfast: 'Petit-déjeuner',
  lunch: 'Déjeuner',
  dinner: 'Dîner',
  bedtime: 'Coucher',
  run: 'Avec la course',
}

const NUTRIENT_LABEL: Record<string, string> = {
  magnesium: 'Magnésium',
  vitamin_d: 'Vitamine D',
  vitamin_k2: 'Vitamine K2',
  vitamin_b6: 'Vitamine B6',
  zinc: 'Zinc',
  taurine: 'Taurine',
  ashwagandha: 'Ashwagandha',
  withanolides: 'Withanolides',
}

// A nutrient's French name, or its slug in words
const nutrientName = (slug: string) => NUTRIENT_LABEL[slug] ?? slug.replaceAll('_', ' ')

const units = (count: number, name: string) => `${count} ${name}${count > 1 ? 's' : ''}`

// A supplement's rhythm when it is not a daily dose already listed by moment; null for those
const rhythmLine = (item: SupplementDay['items'][number]): string | null => {
  const { schedule, every_days: every } = item
  const each = every > 1 ? `tous les ${every} jours` : 'tous les jours'
  const next = (day: string | null) =>
    day === null ? 'plus de prise avant l’arrêt' : `prochaine le ${numericDay(day)}`
  switch (schedule.kind) {
    case 'upcoming':
      return `commence le ${numericDay(schedule.next)}, puis ${each}`
    case 'off':
      return `pas aujourd’hui (${each}) · ${next(schedule.next)}`
    case 'dose':
      return every > 1 ? `à prendre aujourd’hui (${each}) · ${next(schedule.next)}` : null
    case 'stopped':
      return null
  }
}

const SCOPE_LABEL = { supplements: 'compléments seuls', total: 'aliments compris' } as const

// The limit cell: the status as words, never as a colour alone
function LimitCell({ total }: { total: NutrientTotal }) {
  if (total.status === 'no-limit') return <span className="muted">pas de limite</span>
  return (
    <>
      <span className={`status ${total.status === 'over' ? 'bad' : 'good'}`}>
        {total.status === 'over' ? 'Au-dessus' : 'Sous la limite'}
      </span>{' '}
      <span className="muted">
        {`${fmt(total.limit.amount)}\u00A0${total.limit.unit}`} · {SCOPE_LABEL[total.limit.scope]}
      </span>
    </>
  )
}

function SupplementsSection({ day }: { day: SupplementDay }) {
  const rhythms = day.items.flatMap((item) => {
    const line = rhythmLine(item)
    return line === null ? [] : [{ name: item.name, line }]
  })
  const { from, nutrients } = day.totals
  const over = nutrients.flatMap((total) => (total.status === 'over' ? [total] : []))
  const cautions = nutrients.filter((total) => total.caution !== null)
  return (
    <section>
      <h2>Compléments</h2>
      <p className="sub">
        Ce qu’il y a à prendre aujourd’hui, et chaque nutriment en moyenne par jour contre sa limite
        haute
      </p>
      {day.items.length === 0 ? (
        <div className="card">
          <p className="note">
            Aucun complément enregistré : le coach les ajoute avec set_supplements.
          </p>
        </div>
      ) : (
        <div className="grid cols-2">
          <div className="card">
            <h2>Aujourd’hui</h2>
            {day.moments.length === 0 ? (
              <p className="note">Rien à prendre aujourd’hui.</p>
            ) : (
              <dl className="moments">
                {day.moments.map(({ moment, take }) => (
                  <div key={moment}>
                    <dt>{MOMENT_LABEL[moment]}</dt>
                    {take.map((intake) => (
                      <dd key={intake.name}>
                        {intake.name} <span className="muted">({intake.brand})</span> ·{' '}
                        {units(intake.units, intake.unit_name)}
                      </dd>
                    ))}
                  </div>
                ))}
              </dl>
            )}
            {rhythms.map(({ name, line }) => (
              <p key={name} className="note">
                <b>{name}</b> : {line}
              </p>
            ))}
          </div>
          <div className="card">
            <h2>Par jour, en moyenne</h2>
            <p className="sub">
              {from > day.today
                ? `À partir du ${numericDay(from)}, quand tous auront commencé`
                : 'Les compléments en cours'}
            </p>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Nutriment</th>
                    <th className="num">Par jour</th>
                    <th>Limite haute</th>
                  </tr>
                </thead>
                <tbody>
                  {nutrients.map((total) => (
                    <tr key={total.nutrient}>
                      <td>{nutrientName(total.nutrient)}</td>
                      <td className="num">{`${fmt(total.per_day, 2)}\u00A0${total.unit}`}</td>
                      <td>
                        <LimitCell total={total} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {over.map((total) => (
              <p key={total.nutrient} className="note">
                <b>{nutrientName(total.nutrient)}</b> : {fmt(total.per_day, 2)} {total.unit} par
                jour, au-dessus des {fmt(total.limit.amount)} {total.limit.unit} (
                {total.limit.source}) : le risque est {total.limit.risk}.
              </p>
            ))}
            {cautions.map((total) => (
              <p key={total.nutrient} className="note">
                <b>{nutrientName(total.nutrient)}</b> : {total.caution}
              </p>
            ))}
            <p className="note muted">
              Limites hautes de l’EFSA pour un adulte ; « aliments compris » : la limite vaut pour
              tout ce que tu manges, les compléments n’en sont qu’une part.
            </p>
          </div>
        </div>
      )}
    </section>
  )
}

// --- The peak weight and its levers

const range = (low: number, high: number) =>
  low === high ? kg(low) : `${fmt(low, 1)} à ${kg(high)}`

// When a goal comes at the plan's pace, and whether before the deficit ends; after it, the phase
// that follows names when
const goalLines = (goal: Goal, view: NutritionView): Array<string> => {
  switch (goal.kind) {
    case 'reached':
      return ['Atteint.']
    case 'no-pace':
      return [
        `Encore ${range(goal.gap_kg.min, goal.gap_kg.max)} ; le plan ne prévoit pas de perte.`,
      ]
    case 'dated': {
      const { fastest, slowest } = goal
      const { min, max } = view.plan.loss_kg_per_week
      const when =
        slowest === null
          ? `au plus tôt le ${numericDay(fastest.by)}`
          : `entre le ${numericDay(fastest.by)} et le ${numericDay(slowest.by)}`
      const weeks =
        slowest === null
          ? `${fmt(fastest.weeks, 1)} semaines au moins`
          : `${fmt(fastest.weeks, 1)} à ${fmt(slowest.weeks, 1)} semaines`
      const lines = [
        `Encore ${range(goal.gap_kg.min, goal.gap_kg.max)} : ${weeks} à ${fmt(min, 2)}–${fmt(max, 2)} kg par semaine, ${when}.`,
      ]
      if (goal.before_deficit_end === true && view.phase !== null) {
        lines.push(`Possible dans le déficit en cours (jusqu’au ${numericDay(view.phase.to)}).`)
      }
      if (goal.before_deficit_end === false && view.phase !== null) {
        const after = view.plan.phases.find((phase) => phase.from > (view.phase?.to ?? ''))
        lines.push(
          `Au-delà du déficit en cours (jusqu’au ${numericDay(view.phase.to)})${after?.label === undefined ? '' : ` : plutôt après ${after.label}`}.`
        )
      }
      return lines
    }
  }
}

function PeakCard({ peak, view }: { peak: PeakWeight; view: NutritionView }) {
  if (peak.kind === 'no-weigh-in') {
    return (
      <div className="card tile">
        <div className="label">Poids de forme</div>
        <div className="value">–</div>
        <p className="note">
          Aucune pesée du {numericDay(peak.from)} au {numericDay(peak.to)}.
        </p>
      </div>
    )
  }
  const target = (
    <p className="note">
      <b>Cible proche du plan : {kg(view.plan.target_kg, 0)}</b> (moyenne actuelle{' '}
      {kg(peak.weight_kg)}). {goalLines(peak.target, view).join(' ')}
    </p>
  )
  if (peak.kind === 'too-few') {
    return (
      <div className="card tile">
        <div className="label">Poids de forme</div>
        <div className="value">–</div>
        <p className="note">
          Il faut au moins 3 pesées avec la masse grasse sur 14 jours : {peak.weigh_ins.with_fat} du{' '}
          {numericDay(peak.from)} au {numericDay(peak.to)}.
        </p>
        {target}
      </div>
    )
  }
  const { peak: goal } = peak
  return (
    <div className="card tile">
      <div className="label">Poids de forme · long terme</div>
      <div className="value">
        {fmt(goal.kg.min, 1)}–{fmt(goal.kg.max, 1)}
        <small>kg</small>
      </div>
      <p className="note">
        Ta masse maigre, {kg(peak.lean_kg)} ({kg(peak.weight_kg)} à {fmt(peak.body_fat_pct, 1)} % de
        graisse, {peak.weigh_ins.with_fat} pesées du {numericDay(peak.from)} au{' '}
        {numericDay(peak.to)}), gardée, à 10–13 % de graisse : la fourchette d’un coureur
        d’endurance.
      </p>
      <p className="note">
        La balance mesure la graisse par impédance, à ±5 points près : avec cette erreur, la
        fourchette va de {kg(peak.bia_kg.min)} à {kg(peak.bia_kg.max)}. Une fourchette, pas un
        chiffre.
      </p>
      <p className="note">{goalLines(goal, view).join(' ')}</p>
      {target}
      <p className="note muted">
        Plancher : {kg(goal.kg.min)} (10 % de graisse), ne vise pas en dessous. Manger trop peu pour
        ton entraînement (faible disponibilité énergétique, RED-S) coûte de la fatigue, des
        blessures et de la performance.
      </p>
    </div>
  )
}

const LEVER_TITLE: Record<LeverKey, string> = {
  'rest-days': 'Jours de repos',
  breakfast: 'Petit-déjeuner et alcool',
  protein: 'Protéines',
  strength: 'Renforcement',
  running: 'Volume de course',
  steps: 'Pas au quotidien',
  sleep: 'Sommeil',
}

// The status as words, with a colour only where the data judges
const LEVER_STATUS: Record<Lever['status'], { readonly word: string; readonly tone: string }> = {
  room: { word: 'À travailler', tone: 'status wait' },
  fine: { word: 'Tenu', tone: 'status good' },
  untracked: { word: 'Non suivi', tone: 'muted' },
  'no-data': { word: 'Pas de données', tone: 'muted' },
}

// A lever's number with its unit and window, and its effect
const leverFacts = (lever: Lever) => {
  const { measured, kcal_per_day: kcal } = lever
  const value =
    measured === null
      ? null
      : `${fmt(measured.value, 2)} ${measured.unit} · du ${numericDay(measured.from)} au ${numericDay(measured.to)}`
  const effect =
    kcal === null
      ? null
      : `effet ≈ ${kcal.min === kcal.max ? fmt(kcal.max) : `${fmt(kcal.min)} à ${fmt(kcal.max)}`} kcal / jour`
  return [value, effect].filter((part) => part !== null).join(' · ')
}

function LeversCard({ levers }: { levers: ReadonlyArray<Lever> }) {
  return (
    <div className="card">
      <h2>Leviers</h2>
      <p className="sub">
        Classés : d’abord ce que tes données montrent à travailler, l’effet le plus grand en tête
      </p>
      <ol className="levers">
        {levers.map((lever) => (
          <li key={lever.key}>
            <div className="lever-head">
              <h3>{LEVER_TITLE[lever.key]}</h3>
              <span className={LEVER_STATUS[lever.status].tone}>
                {LEVER_STATUS[lever.status].word}
              </span>
            </div>
            {leverFacts(lever) === '' ? null : <p className="note muted">{leverFacts(lever)}</p>}
            <p className="note">{lever.text}</p>
          </li>
        ))}
      </ol>
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
    `statut : ${statusText(view.status, view.plan).label}`,
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

      <SupplementsSection day={view.supplements} />

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
        <h2>Poids de forme</h2>
        <p className="sub">
          Estimé depuis la masse maigre des pesées Withings des 14 derniers jours, en la gardant ;
          la cible du plan reste l’étape proche
        </p>
        <div className="grid cols-2">
          <PeakCard peak={view.peak} view={view} />
          <LeversCard levers={view.levers} />
        </div>
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
