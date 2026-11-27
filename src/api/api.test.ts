import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { createRouterClient, ORPCError } from '@orpc/server'
import { Effect, ManagedRuntime } from 'effect'
import { afterAll, describe, expect, it } from 'vitest'

import { anatomyCatalog, dataDir, put, testLayer } from '../../test/fixtures.ts'
import { gpxText, syntheticCourse } from '../../test/races.ts'
import { Services } from '../app.ts'
import { addDays, mondayOf, parisToday } from '../days.ts'
import { Ingest } from '../ingest.ts'
import { DEFAULT_PLAN, PLAN_PATH } from '../nutrition/plan.ts'
import { DEFAULT_PROGRAM, phaseOn, PROGRAM_PATH } from '../strength/program.ts'

import { makeHandlers, makeRun } from './handlers.ts'
import { router } from './router.ts'

// The API over the app's services on a test database: the data procedures run for real, the Garmin
// ones are not called (any HTTP request dies)
const runtime = ManagedRuntime.make(testLayer(Services))
afterAll(() => runtime.dispose())

const run = makeRun(runtime)
const { handleApi, handleMcp, handleRpc } = makeHandlers(run)
const ORIGIN = 'https://garmin.test'

// One JSON-RPC exchange with the MCP, as a 2025 client (stateless)
const mcp = async (method: string, params: object = {}) => {
  const response = await handleMcp(
    new Request(`${ORIGIN}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2025-06-18',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    })
  )
  const text = await response.text()
  const json = text.startsWith('{')
    ? text
    : (text.split('\n').find((line) => line.startsWith('data:')) ?? '').slice(5)
  return (JSON.parse(json) as { result: Record<string, unknown> }).result
}

const call = async (name: string, args: object) => {
  const result = (await mcp('tools/call', { name, arguments: args })) as {
    isError?: boolean
    structuredContent?: unknown
    content: Array<{ text: string }>
  }
  return {
    isError: result.isError === true,
    data: result.structuredContent ?? JSON.parse(result.content[0]?.text ?? 'null'),
  }
}

interface ListedTool {
  readonly name: string
  readonly description: string
  readonly inputSchema: {
    readonly properties?: Record<string, unknown>
    readonly required?: Array<string>
  }
  readonly annotations: Record<string, boolean>
}

describe('the MCP', () => {
  it('lists the tools by their names, with their inputs and what they change', async () => {
    const { tools } = (await mcp('tools/list')) as { tools: Array<ListedTool> }
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]))
    expect(Object.keys(byName).toSorted()).toEqual([
      'add_race',
      'body_history',
      'caffeine_today',
      'caffeine_vs_sleep',
      'compare_runs',
      'create_workout',
      'daily_readiness',
      'delete_caffeine',
      'delete_meal',
      'delete_workout',
      'find_exercises',
      'get_activity',
      'get_race',
      'list_activities',
      'list_races',
      'list_workouts',
      'log_caffeine',
      'log_meal',
      'log_note',
      'nutrition_plan',
      'nutrition_today',
      'plan_race',
      'planned_workouts',
      'schedule_strength',
      'schedule_workout',
      'schema',
      'set_nutrition_plan',
      'set_strength_program',
      'set_supplements',
      'sleep_insights',
      'sql',
      'strength_history',
      'strength_program',
      'supplements',
      'sync_status',
      'unschedule_workout',
      'weekly_load',
    ])
    // The web pages' procedures are not tools
    expect(tools.some((tool) => tool.name.startsWith('web'))).toBe(false)
    expect(Object.keys(byName['create_workout']?.inputSchema.properties ?? {})).toEqual([
      'name',
      'sport',
      'description',
      'steps',
      'estimated_minutes',
      'schedule',
      'dry_run',
      'allow_duplicate_name',
    ])
    expect(byName['create_workout']?.inputSchema.required).toEqual(['name', 'sport', 'steps'])
    expect(byName['unschedule_workout']?.inputSchema.required).toEqual([
      'schedule_id',
      'date',
      'name',
    ])
    expect(byName['delete_workout']?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
    })
    expect(byName['sql']?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false })
    expect(byName['add_race']?.inputSchema.required).toEqual(['name', 'date'])
    expect(byName['add_race']?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
    })
    expect(byName['plan_race']?.annotations).toMatchObject({
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    })
    expect(byName['plan_race']?.inputSchema.required).toEqual(['slug', 'segments'])
    // A pinned pain, as the body map writes it: plain JSON Schema the model can fill
    const body = byName['log_note']?.inputSchema.properties?.['body'] as {
      properties: Record<string, unknown>
      required: Array<string>
    }
    expect(Object.keys(body.properties)).toEqual([
      'structure',
      'side',
      'point',
      'pain',
      'kind',
      'when',
      'since',
    ])
    expect(body.required).toEqual(['structure', 'side', 'pain', 'kind', 'when'])
    expect(body.properties['side']).toMatchObject({ enum: ['left', 'right', 'midline'] })
    expect(body.properties['pain']).toMatchObject({ type: 'integer', minimum: 0, maximum: 10 })
    expect(byName['body_history']?.annotations).toMatchObject({ readOnlyHint: true })
    expect(byName['nutrition_today']?.annotations).toMatchObject({ readOnlyHint: true })
    expect(byName['set_nutrition_plan']?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    })
    expect(byName['set_nutrition_plan']?.inputSchema.required).toContain('phases')
    expect(byName['supplements']?.annotations).toMatchObject({ readOnlyHint: true })
    expect(byName['set_supplements']?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
    })
    expect(byName['set_supplements']?.inputSchema.required).toEqual(['supplements'])
    expect(byName['sleep_insights']?.annotations).toMatchObject({ readOnlyHint: true })
    expect(byName['sleep_insights']?.inputSchema.properties?.['days']).toMatchObject({
      anyOf: [
        { type: 'number', enum: [30] },
        { type: 'number', enum: [90] },
        { type: 'number', enum: [365] },
        { type: 'string', enum: ['all'] },
      ],
    })
    // Plain JSON Schema numbers for the model
    expect(byName['list_activities']?.inputSchema.properties?.['limit']).toMatchObject({
      type: 'integer',
    })
  })

  it('is counted and named in the README, each write once in the data model', async () => {
    const { tools } = (await mcp('tools/list')) as { tools: Array<ListedTool> }
    const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8')
    const counts = Array.from(readme.matchAll(/(\d+) tools/gu), (match) => Number(match[1]))
    // Its summary and its list's title
    expect(counts).toEqual([tools.length, tools.length])
    expect(tools.filter((tool) => !readme.includes(`\`${tool.name}\``))).toEqual([])
    // DATA_MODEL's first line, after the schema tool's own sentence: what each write does
    const model = tools.find((tool) => tool.name === 'schema')?.description.split('\n\n')[1]
    const writes = model?.split('\n')[0] ?? ''
    const written = tools.filter((tool) => tool.annotations['readOnlyHint'] === false)
    expect(written.length).toBeGreaterThan(0)
    const unwritten = written.filter(
      (tool) => writes.match(new RegExp(`\\b${tool.name}\\b`, 'gu'))?.length !== 1
    )
    expect(unwritten.map((tool) => tool.name)).toEqual([])
  })

  it('answers a call, and an error the model can read', async () => {
    expect(await call('sql', { query: 'SELECT 1 AS one' })).toEqual({
      isError: false,
      data: { rows: [{ one: 1 }] },
    })
    expect(await call('find_exercises', { query: 'side plank', limit: 1 })).toEqual({
      isError: false,
      data: { exercises: [{ name: 'Side Plank', category: 'PLANK', exercise_name: 'SIDE_PLANK' }] },
    })
    expect(await call('log_note', { text: 'Quadri raide' })).toMatchObject({
      isError: false,
      data: { day: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/u), text: 'Quadri raide' },
    })
    expect(await call('log_note', { day: '23/11', text: 'x' })).toMatchObject({
      isError: true,
      data: { code: 'BAD_REQUEST', data: { issues: [{ path: ['day'] }] } },
    })
    expect(await call('get_activity', { id: 404 })).toMatchObject({
      isError: true,
      data: { code: 'NOT_FOUND', message: 'No activity 404.' },
    })
    expect(await call('compare_runs', { ids: [] })).toMatchObject({
      isError: true,
      data: { code: 'BAD_REQUEST', message: 'Compare 1 to 10 activities.' },
    })
    expect(await call('sql', { query: 'DELETE FROM daily' })).toMatchObject({
      isError: true,
      data: { code: 'BAD_REQUEST', message: expect.stringMatching(/not authorized/u) },
    })
    expect(await call('list_activities', { limit: 'ten' })).toMatchObject({
      isError: true,
      data: { code: 'BAD_REQUEST', message: 'Input validation failed' },
    })
  })
})

describe('the race tools', () => {
  // A 9 km course: 3 km flat, 3 km up 300 m, 3 km down
  const course = syntheticCourse([
    [3000, 0],
    [3000, 300],
    [3000, -300],
  ])

  it('adds a race, refuses its slug twice, plans it and reads it back', async () => {
    const added = await call('add_race', {
      name: 'Trail du Test',
      date: '2027-09-25',
      start_time: '06:00',
      cutoffs: [{ km: 6, time: '09:00' }],
      gpx: gpxText(course.points),
    })
    expect(added).toMatchObject({
      isError: false,
      data: { slug: 'trail-du-test-2027', km: 9, planned: false, prediction: null },
    })
    expect(
      await call('add_race', {
        name: 'Trail du Test',
        date: '2027-09-25',
        gpx: gpxText(course.points),
      })
    ).toMatchObject({
      isError: true,
      data: { code: 'BAD_REQUEST', message: expect.stringMatching(/existe déjà/u) },
    })
    expect(await call('add_race', { name: 'Sans GPX', date: '2027-01-01' })).toMatchObject({
      isError: true,
      data: { code: 'BAD_REQUEST', message: expect.stringMatching(/gpx is required/u) },
    })
    expect(
      await call('add_race', { name: 'Faux', date: '2027-01-01', gpx: '<html/>' })
    ).toMatchObject({
      isError: true,
      data: { message: "pas un fichier GPX (pas d'élément <gpx>)" },
    })

    const planned = await call('plan_race', {
      slug: 'trail-du-test-2027',
      carbs_g_per_h: 70,
      segments: [
        { segment: 2, pace: "11'00/km", hr: { low: 145, high: 158 }, fuel: '1 gel au pied' },
      ],
    })
    expect(planned).toMatchObject({
      isError: false,
      data: {
        planned: true,
        fuel: { carbs_g_per_h: 70 },
        segments: [{ plan: null }, { plan: { pace_s: 660 } }, { plan: null }],
      },
    })
    expect(
      await call('plan_race', { slug: 'trail-du-test-2027', segments: [{ segment: 7 }] })
    ).toMatchObject({
      isError: true,
      data: { message: 'segment 7 : le parcours en a 3' },
    })

    // The facts replaced, the course and the plan kept
    expect(
      await call('add_race', {
        slug: 'trail-du-test-2027',
        name: 'Trail du Test',
        date: '2027-09-25',
        aid_stations: [{ km: 4.5, name: 'Refuge', offers: 'eau' }],
      })
    ).toMatchObject({
      isError: false,
      data: { planned: true, facts: { aid_stations: [{ name: 'Refuge' }] } },
    })

    expect(await call('list_races', {})).toMatchObject({
      isError: false,
      data: {
        races: [{ _tag: 'Race', slug: 'trail-du-test-2027', planned: true, predicted_s: null }],
      },
    })
    expect(await call('get_race', { slug: 'nope-2027' })).toMatchObject({
      isError: true,
      data: { code: 'NOT_FOUND', message: 'No race nope-2027.' },
    })
    expect(await call('get_race', { slug: '../garmin' })).toMatchObject({ isError: true })
  })
})

describe("the body map's pains", () => {
  it('logs a pain on a structure, then reads it back named, with its trend', async () => {
    await runtime.runPromise(put('anatomy/structures.json', anatomyCatalog))
    const body = {
      structure: 'vastus_lateralis_r',
      side: 'right',
      point: [-0.12, 0.62, 0.03],
      pain: 6,
      kind: 'vive',
      when: ['descente', 'escaliers'],
      since: '2026-11-16',
    }
    const logged = await call('log_note', { text: 'Douleur vive 6/10 après le semi', body })
    expect(logged).toMatchObject({ isError: false, data: { body } })
    expect(
      await call('log_note', { text: 'x', body: { ...body, structure: 'vastus_lateralis' } })
    ).toMatchObject({
      isError: true,
      data: {
        code: 'BAD_REQUEST',
        message: expect.stringMatching(
          /^Unknown structure "vastus_lateralis"; closest: vastus_lateralis_r/u
        ),
      },
    })
    expect(await call('log_note', { text: 'x', body: { ...body, pain: 11 } })).toMatchObject({
      isError: true,
      data: { code: 'BAD_REQUEST', data: { issues: [{ path: ['body', 'pain'] }] } },
    })

    const history = await call('body_history', { days: 7 })
    expect(history.isError).toBe(false)
    expect(history.data).toMatchObject({
      pins: [
        {
          text: 'Douleur vive 6/10 après le semi',
          body,
          names: {
            french: 'vaste latéral (quadriceps)',
            english: 'Vastus lateralis (quadriceps)',
            latin: 'Musculus vastus lateralis',
            label: 'vaste latéral (quadriceps), côté droit',
          },
          tissue: 'muscle',
          region: 'thigh',
        },
      ],
      structures: [
        { structure: 'vastus_lateralis_r', side: 'right', count: 1, latest_pain: 6, change: 0 },
      ],
    })
    expect(await call('body_history', { days: 0 })).toMatchObject({ isError: true })
  })

  it('reads the `days` days ending today, the first one included', async () => {
    const today = await runtime.runPromise(parisToday)
    const pinned = (day: string, text: string) =>
      put(`journal/${day.slice(0, 4)}/${day}T06-00-00.000Z.json`, {
        time: `${day}T06:00:00.000Z`,
        day,
        text,
        body: { structure: 'linea_alba', side: 'midline', pain: 2, kind: 'raideur', when: [] },
      })
    await runtime.runPromise(
      Effect.all([
        pinned(addDays(today, -7), 'hors période'),
        pinned(addDays(today, -6), 'premier jour'),
      ]).pipe(Effect.andThen(Ingest.use((ingest) => ingest.run())))
    )
    const { data } = (await call('body_history', { days: 7 })) as {
      data: { from: string; to: string; pins: Array<{ text: string }> }
    }
    expect([data.from, data.to]).toEqual([addDays(today, -6), today])
    const texts = data.pins.map((pin) => pin.text)
    expect(texts).toContain('premier jour')
    expect(texts).not.toContain('hors période')
  })
})

describe('the sleep insights', () => {
  it('reads 90 nights by default, and says what is missing on an empty history', async () => {
    const today = await runtime.runPromise(parisToday)
    const { isError, data } = await call('sleep_insights', {})
    expect(isError).toBe(false)
    expect(data).toMatchObject({
      from: addDays(today, -89),
      to: today,
      nights: 0,
      plan: { kind: 'too-few', missing: ['plateau', 'anchor', 'awake'], mornings: 0 },
      regularity: {
        bed_sd: { kind: 'few', nights: 0 },
        social_jetlag: { kind: 'few', weekend: 0, weekday: 0 },
      },
      tags: { nights: [], supplements: null },
    })
    expect(await call('sleep_insights', { days: 30 })).toMatchObject({
      data: { from: addDays(today, -29) },
    })
    expect(await call('sleep_insights', { days: 7 })).toMatchObject({
      isError: true,
      data: { code: 'BAD_REQUEST' },
    })
  })

  it('takes its period as text over OpenAPI', async () => {
    const all = await handleApi(new Request(`${ORIGIN}/api/sleep/insights?days=all`))
    expect(all.status).toBe(200)
    const ninety = await handleApi(new Request(`${ORIGIN}/api/sleep/insights?days=90`))
    expect(ninety.status).toBe(200)
  })
})

describe('the nutrition tools', () => {
  it('reads the default plan without writing it, then the one written, and says a broken one', async () => {
    const file = join(await runtime.runPromise(dataDir), PLAN_PATH)
    expect(await call('nutrition_plan', {})).toEqual({
      isError: false,
      data: { plan: DEFAULT_PLAN, saved: false },
    })
    expect(existsSync(file)).toBe(false)
    const plan = { ...DEFAULT_PLAN, protein_g: 135 }
    expect(await call('set_nutrition_plan', plan)).toEqual({ isError: false, data: plan })
    expect(await call('nutrition_plan', {})).toEqual({
      isError: false,
      data: { plan, saved: true },
    })
    expect(
      await call('set_nutrition_plan', { ...plan, loss_kg_per_week: { min: 0.5, max: 0.3 } })
    ).toMatchObject({ isError: true, data: { code: 'BAD_REQUEST' } })
    await runtime.runPromise(put(PLAN_PATH, '{"protein_g": "beaucoup"'))
    expect(await call('nutrition_today', {})).toMatchObject({
      isError: true,
      data: { code: 'BAD_REQUEST', message: expect.stringMatching(/^nutrition\/plan\.json : /u) },
    })
    await runtime.runPromise(put(PLAN_PATH, DEFAULT_PLAN))
  })

  it('writes the supplements whole, refuses a stop before its start, and reads them back', async () => {
    expect(await call('supplements', {})).toEqual({
      isError: false,
      data: { supplements: [], saved: false },
    })
    const list = {
      supplements: [
        {
          name: 'Magnésium test',
          brand: 'Marque A',
          unit_name: 'gélule',
          intakes: [
            { moment: 'lunch', units: 1 },
            { moment: 'dinner', units: 1 },
          ],
          serving_units: 2,
          contents: [{ nutrient: 'magnesium', amount: 300, unit: 'mg' }],
          every_days: 1,
          start: '2026-01-01',
        },
      ],
    }
    expect(await call('set_supplements', list)).toEqual({ isError: false, data: list })
    expect(await call('supplements', {})).toEqual({
      isError: false,
      data: { ...list, saved: true },
    })
    const [first] = list.supplements
    expect(
      await call('set_supplements', { supplements: [{ ...first, stop: '2025-12-31' }] })
    ).toMatchObject({ isError: true, data: { code: 'BAD_REQUEST' } })
    // Over the 250 mg of magnesium from supplements, and said so in today's answer
    const { data } = (await call('nutrition_today', {})) as {
      data: { supplements: { totals: { nutrients: Array<Record<string, unknown>> } } }
    }
    expect(data.supplements.totals.nutrients).toMatchObject([
      { nutrient: 'magnesium', per_day: 300, unit: 'mg', status: 'over' },
    ])
    await call('set_supplements', { supplements: [] })
  })

  it("answers today's target, the trend and its status", async () => {
    const today = await runtime.runPromise(parisToday)
    const { isError, data } = await call('nutrition_today', {})
    expect(isError).toBe(false)
    // No session in the test database: a rest day; no weigh-in: too few to say
    expect(data).toMatchObject({
      today,
      day: { type: 'rest', from: 'nothing' },
      target: { kcal: 1900, protein_g: 130, run_carbs_g_per_h: null },
      trend: { kind: 'too-few', weigh_ins: 0 },
      latest: null,
    })
    expect(Object.keys(data as object).toSorted()).toEqual([
      'day',
      'latest',
      'levers',
      'peak',
      'phase',
      'status',
      'supplements',
      'target',
      'today',
      'trend',
    ])
    // No weigh-in, no supplement file: said, not guessed
    expect(data).toMatchObject({
      peak: { kind: 'no-weigh-in' },
      supplements: { moments: [], items: [], totals: { nutrients: [] } },
    })
  })
})

describe('the strength tools', () => {
  // The body tests above left the fixture's few structures as the model's catalog
  const knee = {
    ...DEFAULT_PROGRAM,
    sessions: [{ id: 'A', name: 'Genou', focus: 'Vastes', exercises: ['split_squat'] }],
    exercises: [
      {
        ...DEFAULT_PROGRAM.exercises[0],
        primary: ['vastus_lateralis_l', 'vastus_lateralis_r'],
        secondary: ['patellar_ligament_r'],
      },
    ],
  }

  it('reads the default programme, refuses a muscle the live model lacks, writes one it has', async () => {
    const file = join(await runtime.runPromise(dataDir), PROGRAM_PATH)
    expect(await call('strength_program', {})).toEqual({
      isError: false,
      data: { program: DEFAULT_PROGRAM, saved: false },
    })
    expect(existsSync(file)).toBe(false)
    const refused = await call('set_strength_program', DEFAULT_PROGRAM)
    expect(refused).toMatchObject({ isError: true, data: { code: 'BAD_REQUEST' } })
    expect((refused.data as { message: string }).message).toContain(
      'split_squat : vastus_medialis_l inconnu'
    )
    expect(existsSync(file)).toBe(false)
    expect(
      await call('set_strength_program', {
        ...knee,
        exercises: [{ ...knee.exercises[0], primary: ['quadriceps_r'] }],
      })
    ).toMatchObject({ isError: true, data: { code: 'BAD_REQUEST' } })
    expect(await call('set_strength_program', knee)).toEqual({ isError: false, data: knee })
    expect(await call('strength_program', {})).toEqual({
      isError: false,
      data: { program: knee, saved: true },
    })
    await runtime.runPromise(put(PROGRAM_PATH, DEFAULT_PROGRAM))
  })

  it('says no session was done yet', async () => {
    const { isError, data } = await call('strength_history', {})
    expect(isError).toBe(false)
    expect(data).toMatchObject({ target: 2, total: 0, progressions: [], last: null })
    expect((data as { weeks: Array<{ sessions: number }> }).weeks).toHaveLength(12)
  })

  it('places a week and returns its workouts in a dry run, calling nothing on Garmin', async () => {
    const today = await runtime.runPromise(parisToday)
    const week = addDays(mondayOf(today), 7)
    const { isError, data } = await call('schedule_strength', { week, dry_run: true })
    expect(isError).toBe(false)
    const answer = data as {
      dry_run: boolean
      week: string
      sessions: Array<{ day: string; session: string; workout_name: string }>
      workouts: Array<{ schedule: Array<string>; steps: Array<string>; payload: unknown }>
    }
    expect(answer).toMatchObject({ dry_run: true, week })
    expect(answer.workouts).toHaveLength(answer.sessions.length)
    // No run in the test database: an empty week, two sessions as far apart as can be (none in a
    // week no phase covers, the recovery week after the marathon, or past the programme's end)
    if (phaseOn(DEFAULT_PROGRAM.phases, week) !== null) {
      expect(answer.sessions.map((session) => session.session)).toEqual(['A', 'B'])
      expect(answer.workouts[0]?.schedule).toEqual([answer.sessions[0]?.day])
      expect(answer.workouts[0]?.payload).toMatchObject({
        sportType: { sportTypeKey: 'strength_training' },
      })
    }
  })
})

describe('the caffeine tools', () => {
  it('logs an intake, reads today, deletes it by its time over REST', async () => {
    const today = await runtime.runPromise(parisToday)
    const logged = await call('log_caffeine', { kind: 'double_espresso', time: '00:01' })
    expect(logged).toMatchObject({
      isError: false,
      data: { kind: 'double_espresso', mg: 126, time: expect.any(String) },
    })
    const { time } = logged.data as { time: string }
    const { data } = await call('caffeine_today', {})
    expect(data).toMatchObject({
      today,
      total_mg: 126,
      intakes: [{ time, day: today, clock: '00:01', mg: 126, note: null }],
      bedtime: { clock: '23:30' },
      cutoff: { clock: '13:52' },
      rule_cutoff: { clock: '14:42' },
    })
    expect(await call('log_caffeine', { kind: 'custom' })).toMatchObject({
      isError: true,
      data: { code: 'BAD_REQUEST', message: 'Un « autre » a besoin de ses mg de caféine.' },
    })

    const deleted = await handleApi(
      new Request(`${ORIGIN}/api/caffeine/${encodeURIComponent(time)}`, { method: 'DELETE' })
    )
    expect(deleted.status).toBe(200)
    expect(await deleted.json()).toEqual({ time, kind: 'double_espresso', mg: 126 })
    expect(await call('delete_caffeine', { time })).toMatchObject({
      isError: true,
      data: { code: 'BAD_REQUEST', message: `No caffeine intake at ${time}.` },
    })
    expect(await call('delete_caffeine', { time: '../journal' })).toMatchObject({ isError: true })
    expect(await call('caffeine_vs_sleep', {})).toEqual({
      isError: false,
      data: { comparison: { kind: 'too-few', high: 0, low: 0, needed: 10 }, nights: [] },
    })
  })
})

describe('the meal tools', () => {
  it('logs a meal, refuses what it cannot place, deletes it by its time over REST', async () => {
    const today = await runtime.runPromise(parisToday)
    const logged = await call('log_meal', { kind: 'breakfast', time: '00:01', note: 'café' })
    expect(logged).toMatchObject({
      isError: false,
      data: { kind: 'breakfast', note: 'café', time: expect.any(String) },
    })
    const { time } = logged.data as { time: string }
    const { data } = await call('sql', { query: 'SELECT day, kind, note FROM meals' })
    expect(data).toEqual({ rows: [{ day: today, kind: 'breakfast', note: 'café' }] })
    expect(await call('log_meal', { kind: 'dinner', day: today })).toMatchObject({
      isError: true,
      data: {
        code: 'BAD_REQUEST',
        message: `Le ${today} sans heure : donne aussi l’heure (HH:MM).`,
      },
    })
    expect(
      await call('log_meal', { kind: 'dinner', day: addDays(today, 1), time: '20:00' })
    ).toMatchObject({
      isError: true,
      data: { code: 'BAD_REQUEST', message: `Le ${addDays(today, 1)} à 20:00 est dans le futur.` },
    })
    expect(await call('log_meal', { kind: 'brunch' })).toMatchObject({ isError: true })

    const deleted = await handleApi(
      new Request(`${ORIGIN}/api/meals/${encodeURIComponent(time)}`, { method: 'DELETE' })
    )
    expect(deleted.status).toBe(200)
    expect(await deleted.json()).toEqual({ time, kind: 'breakfast', note: 'café' })
    expect(await call('delete_meal', { time })).toMatchObject({
      isError: true,
      data: { code: 'BAD_REQUEST', message: `No meal at ${time}.` },
    })
    expect(await call('delete_meal', { time: '../journal' })).toMatchObject({ isError: true })
    // The sleep analysis reads the meals: none left, no dinner night
    expect(await call('sleep_insights', {})).toMatchObject({
      data: { dinner: { nights: [], gap: [{ nights: 0 }, { nights: 0 }, { nights: 0 }] } },
    })
  })
})

describe('the OpenAPI and RPC faces', () => {
  it('documents the public procedures, not the web pages', async () => {
    const response = await handleApi(new Request(`${ORIGIN}/api/openapi.json`))
    const document = (await response.json()) as {
      servers: Array<{ url: string }>
      paths: Record<string, Record<string, { operationId: string }>>
    }
    expect(document.servers).toEqual([{ url: `${ORIGIN}/api` }])
    expect(document.paths['/workouts/{workout_id}']?.['delete']?.operationId).toBe('delete_workout')
    expect(document.paths['/activities']?.['get']?.operationId).toBe('list_activities')
    expect(Object.keys(document.paths).some((path) => path.includes('web'))).toBe(false)
  })

  it('takes query and path parameters as text', async () => {
    const list = await handleApi(new Request(`${ORIGIN}/api/activities?limit=5&sport=running`))
    expect(list.status).toBe(200)
    expect(await list.json()).toEqual([])
    const missing = await handleApi(new Request(`${ORIGIN}/api/activities/404`))
    expect(missing.status).toBe(404)
    expect(await missing.json()).toMatchObject({ message: 'No activity 404.' })
  })

  it('serves every procedure over RPC, the typed client in place too', async () => {
    const response = await handleRpc(
      new Request(`${ORIGIN}/rpc/exercises/find`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ json: { query: 'cat camel' } }),
      })
    )
    expect(response.status).toBe(200)
    const client = createRouterClient(router, { context: { run, origin: ORIGIN } })
    expect((await client.sql({ query: 'SELECT 2 AS two' })).rows).toEqual([{ two: 2 }])
    await expect(client.activities.get({ id: 404 })).rejects.toBeInstanceOf(ORPCError)
  })
})
