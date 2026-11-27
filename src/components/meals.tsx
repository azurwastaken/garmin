import { useRouter } from '@tanstack/react-router'
import { useState } from 'react'

import { api } from '#src/api/client.ts'
import type { Instant } from '#src/caffeine/intake.ts'
import { parisWall } from '#src/days.ts'
import { type Meal, MEAL_KINDS, MEAL_LABELS, type MealRow } from '#src/meals/meal.ts'
import type { Plan } from '#src/sleep-insights.ts'

import { clock, numericDay } from './format.ts'

// The /sleep page's meal card: tonight's dinner and tomorrow's daylight from tonight's target (the
// sleep analysis's plan), « J'ai dîné » in one tap, a meal at another time (yesterday's dinner after
// midnight too), the last meal logged (undoable, whatever its day) and today's (each deletable).
// Every write goes through the API, then the page's data is read again.

const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))

// A form's optional field: empty is absent
const optional = (form: FormData, name: string) => {
  const value = form.get(name)
  return typeof value === 'string' && value !== '' ? value : undefined
}

// "Dîner du 26/11/2026 à 20:30"
const mealText = (meal: Meal) => {
  const wall = parisWall(Date.parse(meal.time))
  return `${MEAL_LABELS[meal.kind]} du ${numericDay(wall.day)} à ${wall.clock}`
}

// Tonight's dinner and tomorrow's light, or why the plan has none yet
function Advice({ plan }: { readonly plan: Plan }) {
  if (plan.kind === 'too-few') return <p className="note muted">{plan.reason}</p>
  const advice = plan.meal_timing
  return (
    <>
      <div className="facts">
        <div>
          <div className="label">Dîner conseillé avant</div>
          <div className="value">{clock(advice.dinner_by)}</div>
        </div>
        <div>
          <div className="label">Petit-déj à partir de</div>
          <div className="value">
            {clock(advice.breakfast_from)}
            <small>12 h de jeûne</small>
          </div>
        </div>
        <div>
          <div className="label">Lumière du jour, 10 à 20 min</div>
          <div className="value">
            {clock(advice.light_from)}–{clock(advice.light_to)}
          </div>
        </div>
      </div>
      <p className="note">{advice.dinner_sentence}</p>
      <p className="note">{advice.light_sentence}</p>
    </>
  )
}

export function MealCard({
  plan,
  today,
  meals,
}: {
  readonly plan: Plan
  readonly today: string
  readonly meals: ReadonlyArray<MealRow & { readonly clock: string }>
}) {
  const router = useRouter()
  // The meal the last log saved: undoable until deleted
  const [last, setLast] = useState<Meal | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // One write at a time: a double tap never logs two dinners
  const act = (write: () => Promise<unknown>) => {
    if (pending) return
    setPending(true)
    setError(null)
    void write()
      .then(() => router.invalidate())
      .catch((cause: unknown) => setError(message(cause)))
      .finally(() => setPending(false))
  }
  const log = (input: Parameters<typeof api.meals.log>[0]) =>
    act(() => api.meals.log(input).then(setLast))
  // Either delete button: the last meal's line goes with it
  const remove = (time: Instant) =>
    act(() =>
      api.meals
        .delete({ time })
        .then(() => setLast((shown) => (shown?.time === time ? null : shown)))
    )

  const other = (event: React.SubmitEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const kind = MEAL_KINDS.find((known) => known === form.get('kind')) ?? 'dinner'
    const day = optional(form, 'day')
    const time = optional(form, 'time')
    log({
      kind,
      ...(day === undefined || day === today ? {} : { day }),
      ...(time === undefined ? {} : { time }),
    })
  }

  return (
    <section className="card meals">
      <h2>Repas et lumière</h2>
      <p className="sub">D'après l'heure visée ce soir · des repères, pas des règles</p>
      <Advice plan={plan} />

      <div className="meal-actions">
        <button
          type="button"
          className="primary"
          disabled={pending}
          onClick={() => log({ kind: 'dinner' })}
        >
          J'ai dîné
        </button>
      </div>
      <details className="meal-other">
        <summary>Un repas à une autre heure…</summary>
        <form className="stack" onSubmit={other}>
          <label>
            Repas
            <select name="kind" defaultValue="dinner">
              {MEAL_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {MEAL_LABELS[kind]}
                </option>
              ))}
            </select>
          </label>
          <label>
            Jour
            <input name="day" type="date" defaultValue={today} max={today} required />
          </label>
          <label>
            Heure
            <input name="time" type="time" required />
          </label>
          <button className="primary" type="submit" disabled={pending}>
            Ajouter
          </button>
        </form>
      </details>

      {last === null ? null : (
        <p className="meal-last">
          <span>Noté : {mealText(last)}</span>
          <button
            type="button"
            className="secondary"
            disabled={pending}
            onClick={() => remove(last.time)}
          >
            Annuler
          </button>
        </p>
      )}
      {error === null ? null : (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {meals.length === 0 ? (
        <p className="note">Aucun repas noté aujourd'hui.</p>
      ) : (
        <ul className="meal-list" aria-label="Repas d'aujourd'hui">
          {meals.map((meal) => (
            <li key={meal.time}>
              <span>{meal.clock}</span>
              <span>
                {MEAL_LABELS[meal.kind]}
                {meal.note === null ? '' : ` · ${meal.note}`}
              </span>
              <button
                type="button"
                className="secondary"
                disabled={pending}
                aria-label={`Supprimer : ${MEAL_LABELS[meal.kind]} de ${meal.clock}`}
                onClick={() => remove(meal.time)}
              >
                Supprimer
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
