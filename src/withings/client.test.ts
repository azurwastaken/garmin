import { expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import { HttpClient } from 'effect/http'

import { fakeGarmin, json } from '../../test/garmin.ts'

import { TOKEN_URL, withingsPost } from './client.ts'

// One call answered `response`: its body, or its error's tag and whether Withings refused it
const answer = (response: () => Response) =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient
    return yield* withingsPost(http, TOKEN_URL, { action: 'requesttoken' }, 'token').pipe(
      Effect.map((body) => ({ ok: body })),
      Effect.catchTag('WithingsRejected', (error) => Effect.succeed({ tag: error._tag })),
      Effect.catchTag('WithingsError', (error) =>
        Effect.succeed({ tag: error._tag, refused: error.refused, message: error.message })
      )
    )
  }).pipe(Effect.provide(fakeGarmin(() => response()).layer))

it.effect('sends a form with the bearer token', () =>
  Effect.gen(function* () {
    const fake = fakeGarmin(() => json({ status: 0, body: { ok: true } }))
    const http = yield* HttpClient.HttpClient.pipe(Effect.provide(fake.layer))
    expect(yield* withingsPost(http, TOKEN_URL, { action: 'requesttoken', a: 'b' }, 'tok')).toEqual(
      { ok: true }
    )
    const [request] = fake.log
    expect(request?.method).toBe('POST')
    expect(request?.headers['authorization']).toBe('Bearer tok')
    expect(Object.fromEntries(new URLSearchParams(request?.body))).toEqual({
      action: 'requesttoken',
      a: 'b',
    })
  })
)

it.effect("reads Withings' status: 0 is the body, 401 a refused token", () =>
  Effect.gen(function* () {
    expect(yield* answer(() => json({ status: 0, body: [1] }))).toEqual({ ok: [1] })
    expect(yield* answer(() => json({ status: 401 }))).toEqual({ tag: 'WithingsRejected' })
    expect(yield* answer(() => new Response(null, { status: 401 }))).toEqual({
      tag: 'WithingsRejected',
    })
  })
)

it.effect('tells a refusal from what may pass later', () =>
  Effect.gen(function* () {
    // Refused: the same call fails the same
    for (const response of [
      () => json({ status: 2555 }),
      () => new Response('', { status: 400 }),
    ]) {
      expect(yield* answer(response)).toMatchObject({ tag: 'WithingsError', refused: true })
    }
    // Later: the rate limit, the server, an answer that is not Withings'
    for (const response of [
      () => json({ status: 601 }),
      () => new Response('', { status: 429 }),
      () => new Response('', { status: 502 }),
      () => json({ message: 'a proxy page' }),
      () => new Response('<html>'),
    ]) {
      expect(yield* answer(response)).toMatchObject({ tag: 'WithingsError', refused: false })
    }
    expect(yield* answer(() => json({ status: 601 }))).toMatchObject({
      message: expect.stringContaining('rate limiting'),
    })
  })
)
