import { CatchBoundary, ClientOnly, createFileRoute, Link, useRouter } from '@tanstack/react-router'
import { lazy, Suspense, useEffect, useMemo, useState } from 'react'

import {
  type BodyPoint,
  type Catalog,
  isShown,
  type Layer,
  LAYERS,
  PAIN_COLOR_VAR,
  painLevel,
  searchStructures,
  type SideFilter,
  type Structure,
  structureLabel,
  structureOf,
} from '#src/anatomy/catalog.ts'
import { api } from '#src/api/client.ts'
import { BODY_PERIODS } from '#src/api/periods.ts'
import { dayLabel } from '#src/components/format.ts'
import {
  PAIN_KIND_LABEL,
  PAIN_KINDS,
  PAIN_WHEN,
  PAIN_WHEN_LABEL,
  type PainKind,
  type PainWhen,
  painSummary,
  type Side,
} from '#src/journal/body-terms.ts'
import { type BodyHistory, type BodyPin, heatOf } from '#src/journal/history.ts'
import type { JournalNote } from '#src/journal/note.ts'

// The body map: the anatomy model as a hologram, its layers peeled, a pain pinned where it hurts
// and written to the journal (the MCP's body_history reads them back for Claude), the period's
// pains on the model. Every structure and every pain is reachable without the 3D view too.

type Period = (typeof BODY_PERIODS)[number]

export const Route = createFileRoute('/body')({
  // ?days= is optional: 30 by default
  validateSearch: (search: Record<string, unknown>): { days?: Period } => {
    const days = BODY_PERIODS.find((period) => period === Number(search['days']))
    return days === undefined || days === 30 ? {} : { days }
  },
  loaderDeps: ({ search }) => ({ days: search.days ?? 30 }),
  loader: ({ deps }) => api.body.history({ days: deps.days }),
  head: () => ({ meta: [{ title: 'Garmin · corps' }] }),
  component: BodyMap,
})

// Three.js only in the browser, in its own chunk
const BodyScene = lazy(() => import('#src/components/body-scene.tsx'))

type CatalogState =
  | { readonly tag: 'loading' }
  | { readonly tag: 'absent' }
  | { readonly tag: 'failed'; readonly message: string }
  | { readonly tag: 'ready'; readonly catalog: Catalog }

type Panel =
  | { readonly tag: 'none' }
  | { readonly tag: 'report'; readonly id: string; readonly point: BodyPoint | null }
  | { readonly tag: 'pin'; readonly time: string }

// The catalog, once: absent when the server has no model
const loadCatalog = async (): Promise<CatalogState> => {
  try {
    const response = await fetch('/anatomy/structures.json')
    if (response.status === 404) return { tag: 'absent' }
    if (!response.ok) return { tag: 'failed', message: `HTTP ${response.status}` }
    // The server's own asset, served as it is
    return { tag: 'ready', catalog: (await response.json()) as Catalog }
  } catch (cause) {
    return { tag: 'failed', message: cause instanceof Error ? cause.message : String(cause) }
  }
}

const useCatalog = () => {
  const [state, setState] = useState<CatalogState>({ tag: 'loading' })
  useEffect(() => {
    void loadCatalog().then(setState)
  }, [])
  return state
}

const PERIOD_LABEL: Record<Period, string> = { 7: '7 jours', 30: '30 jours', 90: '90 jours' }

function BodyMap() {
  const history = Route.useLoaderData()
  const { days = 30 } = Route.useSearch()
  const catalog = useCatalog()
  return (
    <main className="body-page">
      <div className="heading">
        <div>
          <h1>Carte du corps</h1>
          <p className="sub">
            Clique là où ça fait mal : la douleur va au journal, Claude la lit avec body_history
          </p>
        </div>
        <nav className="periods" aria-label="Période">
          {BODY_PERIODS.map((period) => (
            <Link
              key={period}
              to="/body"
              search={period === 30 ? {} : { days: period }}
              className={period === days ? 'on' : undefined}
              activeOptions={{ exact: true, includeSearch: true }}
              aria-current={period === days ? 'page' : undefined}
            >
              {PERIOD_LABEL[period]}
            </Link>
          ))}
        </nav>
      </div>
      {catalog.tag === 'loading' ? <p className="note">Chargement du modèle…</p> : null}
      {catalog.tag === 'absent' ? (
        <p className="note">
          Modèle absent : copie le dossier anatomy/ (runner.glb, structures.json) dans le DATA_DIR
          du serveur.
        </p>
      ) : null}
      {catalog.tag === 'failed' ? (
        <p className="error">Le modèle ne se charge pas : {catalog.message}</p>
      ) : null}
      {catalog.tag === 'ready' ? <Atlas catalog={catalog.catalog} history={history} /> : null}
      <Credits />
    </main>
  )
}

function Atlas({
  catalog,
  history: { pins, structures },
}: {
  readonly catalog: Catalog
  readonly history: BodyHistory
}) {
  const router = useRouter()
  const [layers, setLayers] = useState<ReadonlySet<Layer>>(
    new Set(['surface', 'muscle', 'tendon', 'ligament', 'bone'])
  )
  const [side, setSide] = useState<SideFilter>('both')
  const [hovered, setHovered] = useState<string | null>(null)
  const [panel, setPanel] = useState<Panel>({ tag: 'none' })
  const shown = useMemo(() => {
    const visible = new Set(
      Object.entries(catalog).flatMap(([id, structure]) =>
        isShown(structure, layers, side) ? [id] : []
      )
    )
    return (id: string) => visible.has(id)
  }, [catalog, layers, side])
  const heat = useMemo(() => heatOf(structures), [structures])
  const pick = (id: string, point: BodyPoint | null) => setPanel({ tag: 'report', id, point })
  // After a write: the history again, then the new pain open (its pin is in it)
  const saved = (note: JournalNote) =>
    router.invalidate().then(() => setPanel({ tag: 'pin', time: note.time }))
  const selected = panel.tag === 'report' ? panel.id : null
  const hoveredStructure = hovered === null ? undefined : structureOf(catalog, hovered)

  return (
    <div className="body-layout">
      <section className="body-stage" aria-label="Modèle 3D">
        <ClientOnly fallback={<p className="note body-stage-note">Chargement de la vue 3D…</p>}>
          {/* The scene fails alone (no WebGL): the lists still do everything */}
          <CatchBoundary
            getResetKey={() => 'scene'}
            errorComponent={() => (
              <p className="note body-stage-note">
                Vue 3D indisponible sur ce navigateur : choisis la structure dans la liste.
              </p>
            )}
          >
            <Suspense fallback={<p className="note body-stage-note">Chargement de la vue 3D…</p>}>
              <BodyScene
                catalog={catalog}
                shown={shown}
                selected={selected}
                pins={pins}
                heat={heat}
                onHover={setHovered}
                onPick={pick}
                onPin={(time) => setPanel({ tag: 'pin', time })}
              />
            </Suspense>
          </CatchBoundary>
        </ClientOnly>
        <p className="body-readout" aria-live="polite">
          <span className="body-label">Cible</span>{' '}
          {hoveredStructure === undefined
            ? '—'
            : structureLabel(hoveredStructure.french, hoveredStructure.side)}
        </p>
      </section>
      <div className="body-side">
        <Controls layers={layers} side={side} onLayers={setLayers} onSide={setSide} />
        <PanelView
          panel={panel}
          catalog={catalog}
          pins={pins}
          onSaved={saved}
          onClose={() => setPanel({ tag: 'none' })}
        />
        <PinList pins={pins} onPin={(time) => setPanel({ tag: 'pin', time })} />
        <StructureList catalog={catalog} shown={shown} onPick={(id) => pick(id, null)} />
      </div>
    </div>
  )
}

function Controls({
  layers,
  side,
  onLayers,
  onSide,
}: {
  readonly layers: ReadonlySet<Layer>
  readonly side: SideFilter
  readonly onLayers: (layers: ReadonlySet<Layer>) => void
  readonly onSide: (side: SideFilter) => void
}) {
  const toggle = (layer: Layer) => {
    const next = new Set(layers)
    if (!next.delete(layer)) next.add(layer)
    onLayers(next)
  }
  return (
    <section className="card body-controls">
      <fieldset>
        <legend className="body-label">Couches</legend>
        {LAYERS.map((layer) => (
          <label key={layer.id} className="body-check">
            <input
              type="checkbox"
              checked={layers.has(layer.id)}
              onChange={() => toggle(layer.id)}
            />
            {layer.label}
          </label>
        ))}
      </fieldset>
      <fieldset>
        <legend className="body-label">Côté</legend>
        {(
          [
            ['both', 'Les deux'],
            ['right', 'Droit'],
            ['left', 'Gauche'],
          ] as const
        ).map(([value, label]) => (
          <label key={value} className="body-check">
            <input
              type="radio"
              name="body-side"
              checked={side === value}
              onChange={() => onSide(value)}
            />
            {label}
          </label>
        ))}
      </fieldset>
    </section>
  )
}

function PanelView({
  panel,
  catalog,
  pins,
  onSaved,
  onClose,
}: {
  readonly panel: Panel
  readonly catalog: Catalog
  readonly pins: ReadonlyArray<BodyPin>
  readonly onSaved: (note: JournalNote) => Promise<void>
  readonly onClose: () => void
}) {
  if (panel.tag === 'report') {
    const structure = structureOf(catalog, panel.id)
    if (structure === undefined) return null
    return (
      <PainForm
        key={`${panel.id}/${panel.point?.join(',') ?? ''}`}
        id={panel.id}
        structure={structure}
        point={panel.point}
        onSaved={onSaved}
        onClose={onClose}
      />
    )
  }
  if (panel.tag === 'pin') {
    const pin = pins.find((candidate) => candidate.time === panel.time)
    return pin === undefined ? null : <PinNote pin={pin} onClose={onClose} />
  }
  return (
    <p className="note card">
      Survole le modèle pour nommer une structure, clique pour y placer une douleur. Décoche des
      couches pour atteindre les structures profondes.
    </p>
  )
}

const todayInParis = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Paris' })

function PainForm({
  id,
  structure,
  point,
  onSaved,
  onClose,
}: {
  readonly id: string
  readonly structure: Structure
  readonly point: BodyPoint | null
  readonly onSaved: (note: JournalNote) => Promise<void>
  readonly onClose: () => void
}) {
  const [side, setSide] = useState<Side>(structure.side)
  const [pain, setPain] = useState(5)
  const [kind, setKind] = useState<PainKind>('sourde')
  const [when, setWhen] = useState<ReadonlyArray<PainWhen>>([])
  const [since, setSince] = useState('')
  const [text, setText] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = (event: React.SubmitEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (pending) return
    setPending(true)
    setError(null)
    const body = {
      structure: id,
      side,
      pain,
      kind,
      when: PAIN_WHEN.filter((moment) => when.includes(moment)),
      ...(point === null ? {} : { point }),
      ...(since === '' ? {} : { since }),
    }
    const where = structureLabel(structure.french, side)
    const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))
    void api.journal
      .log({ text: text.trim() === '' ? painSummary(body, where) : text.trim(), body })
      .then(
        // Saved: a failed reload says so, never that the pain was not written
        (note) =>
          onSaved(note).catch((cause: unknown) => {
            setError(`Enregistré, mais la page ne s'est pas rechargée : ${message(cause)}`)
          }),
        (cause: unknown) => {
          setError(message(cause))
        }
      )
      .finally(() => setPending(false))
  }

  return (
    <section className="card body-form">
      <div className="body-panel-head">
        <h2>{structureLabel(structure.french, side)}</h2>
        <button type="button" className="secondary" onClick={onClose}>
          Fermer
        </button>
      </div>
      <p className="note">
        {structure.english} · <i>{structure.latin}</i>
        {point === null ? ' · sans point sur le modèle' : null}
      </p>
      <form className="stack" onSubmit={submit}>
        {structure.side === 'midline' ? (
          <label>
            Côté
            <select value={side} onChange={(event) => setSide(event.target.value as Side)}>
              <option value="midline">Au milieu</option>
              <option value="right">Droit</option>
              <option value="left">Gauche</option>
            </select>
          </label>
        ) : null}
        <label>
          Intensité : {pain}/10
          <input
            type="range"
            min={0}
            max={10}
            step={1}
            value={pain}
            onChange={(event) => setPain(Number(event.target.value))}
          />
        </label>
        <fieldset>
          <legend>Type</legend>
          {PAIN_KINDS.map((value) => (
            <label key={value} className="body-check">
              <input
                type="radio"
                name="body-kind"
                checked={kind === value}
                onChange={() => setKind(value)}
              />
              {PAIN_KIND_LABEL[value]}
            </label>
          ))}
        </fieldset>
        <fieldset>
          <legend>Quand</legend>
          {PAIN_WHEN.map((value) => (
            <label key={value} className="body-check">
              <input
                type="checkbox"
                checked={when.includes(value)}
                onChange={() =>
                  setWhen(
                    when.includes(value)
                      ? when.filter((moment) => moment !== value)
                      : [...when, value]
                  )
                }
              />
              {PAIN_WHEN_LABEL[value]}
            </label>
          ))}
        </fieldset>
        <label>
          Depuis le
          <input
            type="date"
            value={since}
            max={todayInParis()}
            onChange={(event) => setSince(event.target.value)}
          />
        </label>
        <label>
          Note
          <textarea
            rows={3}
            maxLength={2000}
            value={text}
            placeholder="Ce que tu ressens, ce qui l'a déclenché…"
            onChange={(event) => setText(event.target.value)}
          />
        </label>
        {error ? <div className="error">{error}</div> : null}
        <button className="primary" type="submit" disabled={pending}>
          {pending ? 'Enregistrement…' : 'Enregistrer'}
        </button>
      </form>
    </section>
  )
}

const where = (pin: BodyPin) => pin.names?.label ?? pin.body.structure

function PinNote({ pin, onClose }: { readonly pin: BodyPin; readonly onClose: () => void }) {
  const moments = pin.body.when.map((moment) => PAIN_WHEN_LABEL[moment]).join(', ')
  return (
    <section className="card body-form">
      <div className="body-panel-head">
        <h2>{where(pin)}</h2>
        <button type="button" className="secondary" onClick={onClose}>
          Fermer
        </button>
      </div>
      <p>
        <span
          className="status"
          style={{ color: `var(${PAIN_COLOR_VAR[painLevel(pin.body.pain)]})` }}
        >
          {pin.body.pain}/10
        </span>{' '}
        {PAIN_KIND_LABEL[pin.body.kind]}
        {moments === '' ? '' : `, ${moments}`}
      </p>
      <p className="note">
        {dayLabel(pin.day)}
        {pin.body.since === undefined ? '' : ` · depuis le ${dayLabel(pin.body.since)}`}
      </p>
      <p>{pin.text}</p>
    </section>
  )
}

function PinList({
  pins,
  onPin,
}: {
  readonly pins: ReadonlyArray<BodyPin>
  readonly onPin: (time: string) => void
}) {
  return (
    <section className="card">
      <h2>Douleurs de la période</h2>
      {pins.length === 0 ? (
        <p className="note">Aucune douleur notée sur cette période.</p>
      ) : (
        <ul className="body-list">
          {pins.toReversed().map((pin) => (
            <li key={pin.time}>
              <button type="button" onClick={() => onPin(pin.time)}>
                <span
                  className="status"
                  style={{ color: `var(${PAIN_COLOR_VAR[painLevel(pin.body.pain)]})` }}
                >
                  {pin.body.pain}/10
                </span>{' '}
                {where(pin)} <span className="muted">· {dayLabel(pin.day)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function StructureList({
  catalog,
  shown,
  onPick,
}: {
  readonly catalog: Catalog
  readonly shown: (id: string) => boolean
  readonly onPick: (id: string) => void
}) {
  const [query, setQuery] = useState('')
  const found = useMemo(() => searchStructures(catalog, query, shown), [catalog, query, shown])
  return (
    <section className="card">
      <h2>Structures</h2>
      <label>
        Chercher (français ou anglais)
        <input
          type="search"
          value={query}
          placeholder="vaste externe, IT band, rotule…"
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      <p className="note">
        {found.length} structure{found.length > 1 ? 's' : ''} visible{found.length > 1 ? 's' : ''}
      </p>
      <ul className="body-list body-structures">
        {found.slice(0, 80).map(([id, structure]) => (
          <li key={id}>
            <button type="button" onClick={() => onPick(id)}>
              {structureLabel(structure.french, structure.side)}{' '}
              <span className="muted">· {structure.english}</span>
            </button>
          </li>
        ))}
      </ul>
      {found.length > 80 ? <p className="note">Affine la recherche pour voir les autres.</p> : null}
    </section>
  )
}

// ATTRIBUTION.md's required lines (CC BY-SA)
function Credits() {
  return (
    <footer className="note body-credits">
      <p>
        <strong>Z-Anatomy – The libre 3D atlas of anatomy – CC BY-SA 4.0</strong> (
        <a href="https://www.z-anatomy.com">https://www.z-anatomy.com</a>,{' '}
        <a href="https://github.com/Z-Anatomy/Models-of-human-anatomy">
          https://github.com/Z-Anatomy/Models-of-human-anatomy
        </a>
        )
      </p>
      <p>
        <strong>BodyParts3D, © The Database Center for Life Science, CC BY-SA 2.1 JP</strong> (
        <a href="https://dbarchive.biosciencedbc.jp/en/bodyparts3d/download.html">
          https://dbarchive.biosciencedbc.jp/en/bodyparts3d/download.html
        </a>
        )
      </p>
      <p>Modèle modifié (sélection, tendons séparés, compression) et diffusé sous CC BY-SA 4.0.</p>
    </footer>
  )
}
