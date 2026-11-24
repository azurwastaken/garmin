import { Link, useRouter } from '@tanstack/react-router'
import { useState } from 'react'

import { api } from '#src/api/client.ts'
import { type CaffeineIntake, DRINK_KINDS, type DrinkKind, DRINKS } from '#src/caffeine/intake.ts'
import {
  BEDTIME_LEFT_MG,
  type BedtimeSource,
  type CaffeineToday,
  DAY_LIMIT_MG,
  DOSE_LIMIT_MG,
  HALF_LIFE_H,
  RULE_HOURS,
  STANDARD_COFFEE_MG,
} from '#src/caffeine/kinetics.ts'

import { fmt } from './format.ts'

// The Café card (Aujourd'hui and /cafe): one tap per usual drink, any other with its mg and time,
// today's intakes (each deletable, the last tap undoable), the caffeine in the body now and at
// bedtime (tonight's from the sleep analysis, and where it comes from), and the cut-off for the
// last coffee. Every write goes through the API, then the page's data is read again.

const QUICK: ReadonlyArray<DrinkKind> = [
  'espresso',
  'double_espresso',
  'filter',
  'capsule',
  'black_tea',
]

const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))

// Where the bedtime comes from, in French
const bedtimeOrigin = (source: BedtimeSource) =>
  source.kind === 'tonight' ? 'conseil sommeil de ce soir' : 'par défaut, trop peu de nuits'

// A form's optional field: empty is absent
const optional = (form: FormData, name: string) => {
  const value = form.get(name)
  return typeof value === 'string' && value !== '' ? value : undefined
}

export function CafeCard({ today }: { readonly today: CaffeineToday }) {
  const router = useRouter()
  // The intake the last tap saved: undoable while it is still today's
  const [last, setLast] = useState<CaffeineIntake | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const undo = last === null ? undefined : today.intakes.find((i) => i.time === last.time)

  // One write at a time: a double tap never logs two cups
  const act = (write: () => Promise<unknown>) => {
    if (pending) return
    setPending(true)
    setError(null)
    void write()
      .then(() => router.invalidate())
      .catch((cause: unknown) => setError(message(cause)))
      .finally(() => setPending(false))
  }
  const log = (input: Parameters<typeof api.caffeine.log>[0]) =>
    act(() => api.caffeine.log(input).then(setLast))
  const remove = (time: string) => act(() => api.caffeine.delete({ time }))

  const quick = (event: React.SubmitEvent<HTMLFormElement>) => {
    event.preventDefault()
    const kind = event.submitter?.getAttribute('value')
    const drink = DRINK_KINDS.find((known) => known === kind)
    if (drink !== undefined) log({ kind: drink })
  }
  const other = (event: React.SubmitEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const drink = DRINK_KINDS.find((known) => known === form.get('kind')) ?? 'custom'
    const mg = optional(form, 'mg')
    const time = optional(form, 'time')
    log({
      kind: drink,
      ...(mg === undefined ? {} : { mg: Number(mg) }),
      ...(time === undefined ? {} : { time }),
    })
  }

  return (
    <div className="card cafe">
      <div className="cafe-head">
        <h2>Café</h2>
        <Link to="/cafe">historique et sommeil →</Link>
      </div>
      <p>
        <strong>{fmt(today.total_mg)} mg</strong> aujourd'hui ·{' '}
        {today.intakes.length === 1 ? '1 boisson' : `${today.intakes.length} boissons`} · limite{' '}
        {DAY_LIMIT_MG} mg / jour (EFSA)
      </p>
      {today.over_day_limit ? (
        <p className="status bad">Plus de {DAY_LIMIT_MG} mg aujourd'hui</p>
      ) : null}
      {today.strong.length > 0 ? (
        <p className="status wait">
          Plus de {DOSE_LIMIT_MG} mg d'un coup ({today.strong[0]?.clock})
        </p>
      ) : null}
      <p>
        Dans le corps maintenant : ~{fmt(today.now_mg)} mg · au coucher ({today.bedtime.clock},{' '}
        {bedtimeOrigin(today.bedtime_source)}) : ~{fmt(today.bedtime_mg)} mg
      </p>
      <p className={`status ${today.cutoff_passed ? 'wait' : 'good'}`}>
        {today.cutoff_passed
          ? `Seuil passé : le dernier café était conseillé avant ${today.cutoff.clock}`
          : `Dernier café conseillé avant ${today.cutoff.clock}`}
      </p>
      <p className="note">
        Estimations (demi-vie moyenne {HALF_LIFE_H} h, EFSA 2015). Seuil affiché : un café filtre (
        {STANDARD_COFFEE_MG} mg) bu avant {today.cutoff.clock} n'en laisse que {BEDTIME_LEFT_MG} mg
        au coucher. Repère des études : {fmt(RULE_HOURS, 1)} h avant le coucher, soit{' '}
        {today.rule_cutoff.clock} (Gardiner et al. 2023).
      </p>

      <form className="cafe-quick" onSubmit={quick} aria-label="Ajouter une boisson">
        {QUICK.map((kind) => (
          <button
            key={kind}
            type="submit"
            className="secondary"
            name="kind"
            value={kind}
            disabled={pending}
          >
            {DRINKS[kind].label}
            <small>{DRINKS[kind].mg} mg</small>
          </button>
        ))}
      </form>
      <details className="cafe-other">
        <summary>Autre…</summary>
        <form className="stack" onSubmit={other}>
          <label>
            Boisson
            <select name="kind" defaultValue="custom">
              {DRINK_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {DRINKS[kind].label}
                  {DRINKS[kind].mg === null ? '' : ` (${DRINKS[kind].mg} mg)`}
                </option>
              ))}
            </select>
          </label>
          <label>
            Caféine en mg (vide : celle du catalogue)
            <input name="mg" type="number" inputMode="numeric" min={1} max={1000} step={1} />
          </label>
          <label>
            Heure (vide : maintenant)
            <input name="time" type="time" />
          </label>
          <button className="primary" type="submit" disabled={pending}>
            Ajouter
          </button>
        </form>
      </details>

      {undo === undefined ? null : (
        <p>
          <button
            type="button"
            className="secondary"
            disabled={pending}
            onClick={() => remove(undo.time)}
          >
            Annuler : {DRINKS[undo.kind].label} de {undo.clock}
          </button>
        </p>
      )}
      {error === null ? null : (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {today.intakes.length === 0 ? (
        <p className="note">Rien de noté aujourd'hui.</p>
      ) : (
        <ul className="cafe-list" aria-label="Aujourd'hui">
          {today.intakes.map((intake) => (
            <li key={intake.time}>
              <span>{intake.clock}</span>
              <span>
                {DRINKS[intake.kind].label}
                {intake.note === null ? '' : ` · ${intake.note}`}
              </span>
              <span className="num">{fmt(intake.mg)} mg</span>
              <button
                type="button"
                className="secondary"
                disabled={pending}
                aria-label={`Supprimer : ${DRINKS[intake.kind].label} de ${intake.clock}`}
                onClick={() => remove(intake.time)}
              >
                Supprimer
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
