import { writeFileSync } from 'node:fs'

import { expect, layer } from '@effect/vitest'
import { Effect } from 'effect'

import { testLayer } from '../../test/fixtures.ts'
import { fakeGarmin, inHours, json, jwt } from '../../test/garmin.ts'

import { GarminSession } from './session.ts'

const expiring = jwt({ exp: inHours(0.1), client_id: 'client' })
const theirs = jwt({ exp: inHours(24), client_id: 'client' })

// Garmin refuses the refresh token: another process used it first, unless `raced` is off
let raced = true
let sessionPath = ''
const garmin = fakeGarmin(({ url }) => {
  expect(url.host).toBe('diauth.garmin.com')
  if (raced) {
    writeFileSync(
      sessionPath,
      JSON.stringify({ di_token: theirs, di_refresh_token: 'refresh-2', di_client_id: 'client' })
    )
  }
  return json({ error: 'invalid_grant' }, { status: 400 })
})

const save = GarminSession.use((session) =>
  Effect.gen(function* () {
    sessionPath = session.path
    yield* session.save(
      { di_token: expiring, di_refresh_token: 'refresh-1', di_client_id: 'client' },
      null
    )
  })
)

layer(testLayer(GarminSession.layer, garmin.layer), { excludeTestServices: true })(
  'GarminSession',
  (it) => {
    it.effect('takes the session another process refreshed first', () =>
      Effect.gen(function* () {
        raced = true
        yield* save
        expect(yield* GarminSession.use((session) => session.accessToken())).toBe(theirs)
      })
    )

    it.effect('says logged out when Garmin refuses the refresh token', () =>
      Effect.gen(function* () {
        raced = false
        yield* save
        const error = yield* GarminSession.use((session) => session.accessToken()).pipe(Effect.flip)
        expect(error._tag).toBe('NotLoggedIn')
      })
    )
  }
)
