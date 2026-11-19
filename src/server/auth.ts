import { Effect } from 'effect'

import { Auth } from '../auth.ts'
import { isOAuthToken, OAuth } from '../oauth/oauth.ts'

import { runtime } from './runtime.ts'

export const hasPassword = () => runtime.runPromise(Auth.use((auth) => auth.hasPassword))

// An OAuth access token for this MCP, else the password (throttled)
export const verifyBearer = (token: string, client: string, resource: string) =>
  runtime.runPromise(
    Effect.gen(function* () {
      if (yield* OAuth.use((oauth) => oauth.verify(token, resource))) return 'ok' as const
      // An OAuth token refused is not a wrong password: no scrypt, no throttle
      if (isOAuthToken(token)) return 'wrong' as const
      return yield* Auth.use((auth) => auth.verifyBearer(token, client))
    })
  )

export const verifySession = (value: string) =>
  runtime.runPromise(Auth.use((auth) => auth.verifySession(value)))

// A new password, for the current one: every other browser and every OAuth grant must log in again
export const changePassword = (current: string, next: string, client: string) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const outcome = yield* Auth.use((auth) => auth.change(current, next, client))
      if (typeof outcome !== 'string') yield* OAuth.use((oauth) => oauth.revokeAll)
      return outcome
    })
  )
