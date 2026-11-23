import { createRouterClient, ORPCError } from '@orpc/server'
import { Effect, ManagedRuntime } from 'effect'
import { afterAll, describe, expect, it } from 'vitest'

import { anatomyCatalog, put, testLayer } from '../../test/fixtures.ts'
import { Services } from '../app.ts'
import { addDays, parisToday } from '../days.ts'
import { Ingest } from '../ingest.ts'

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
      'body_history',
      'compare_runs',
      'create_workout',
      'daily_readiness',
      'delete_workout',
      'find_exercises',
      'get_activity',
      'list_activities',
      'list_workouts',
      'log_note',
      'planned_workouts',
      'schedule_workout',
      'schema',
      'sql',
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
    // Plain JSON Schema numbers for the model
    expect(byName['list_activities']?.inputSchema.properties?.['limit']).toMatchObject({
      type: 'integer',
    })
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
