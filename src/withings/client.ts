import { Effect, Option, Schema } from 'effect'
import { type HttpClient, HttpClientRequest } from 'effect/http'

import { json } from '../http-body.ts'

// One call to Withings' API: a form POST (with the access token, but for the token endpoint),
// its answer `{ status, body }` checked. Withings answers HTTP 200 for most errors, its status in
// the JSON: 0 is success, 401 a token it refuses, 601 its rate limit. Messages never hold a token.

export const TOKEN_URL = 'https://wbsapi.withings.net/v2/oauth2'
export const MEASURE_URL = 'https://wbsapi.withings.net/measure'

// The access token refused (HTTP 401, or status 401): refreshed, the call can be made again
export class WithingsRejected extends Schema.TaggedError<WithingsRejected>()('WithingsRejected', {
  message: Schema.String,
}) {}

// No session, or Withings refused its refresh: connect again on /garmin
export class WithingsLoggedOut extends Schema.TaggedError<WithingsLoggedOut>()(
  'WithingsLoggedOut',
  { message: Schema.String }
) {}

// Anything else. `refused`: Withings said no (an HTTP 4xx, a status but 0 or 601), the same call
// would fail the same; else it may pass later (a timeout, the network, an HTTP 5xx, the rate limit)
export class WithingsError extends Schema.TaggedError<WithingsError>()('WithingsError', {
  message: Schema.String,
  refused: Schema.Boolean,
}) {}

const Answer = Schema.Struct({ status: Schema.Finite, body: Schema.optional(Schema.Unknown) })
const decodeAnswer = Schema.decodeUnknownOption(Answer)

const RATE_LIMITED = 601

// The answer's checked body
const checked = (
  what: string,
  answer: unknown
): Effect.Effect<unknown, WithingsError | WithingsRejected> => {
  const decoded = decodeAnswer(answer)
  if (Option.isNone(decoded)) {
    return Effect.fail(
      new WithingsError({ message: `${what}: not a Withings answer`, refused: false })
    )
  }
  const { status, body } = decoded.value
  if (status === 0) return Effect.succeed(body)
  if (status === 401)
    return Effect.fail(new WithingsRejected({ message: `${what}: token refused` }))
  return Effect.fail(
    new WithingsError({
      message: `${what}: ${status === RATE_LIMITED ? 'Withings is rate limiting' : `status ${status}`}`,
      refused: status !== RATE_LIMITED,
    })
  )
}

export const withingsPost = (
  http: HttpClient.HttpClient,
  url: string,
  params: Readonly<Record<string, string>>,
  token?: string
): Effect.Effect<unknown, WithingsError | WithingsRejected> => {
  const what = `${new URL(url).pathname} ${params['action'] ?? ''}`.trim()
  return http
    .execute(
      HttpClientRequest.post(url).pipe(
        HttpClientRequest.setHeaders(
          token === undefined ? {} : { authorization: `Bearer ${token}` }
        ),
        HttpClientRequest.bodyUrlParams(params)
      )
    )
    .pipe(
      Effect.mapError(
        (error) => new WithingsError({ message: `${what}: ${error.message}`, refused: false })
      ),
      // A stalled call would hold the refresh's lock, and the sync's, for good
      Effect.timeoutOrElse({
        duration: '60 seconds',
        orElse: () =>
          Effect.fail(new WithingsError({ message: `${what}: no answer in 60 s`, refused: false })),
      }),
      Effect.flatMap((response): Effect.Effect<unknown, WithingsError | WithingsRejected> => {
        if (response.status === 401) {
          return Effect.fail(new WithingsRejected({ message: `${what}: HTTP 401` }))
        }
        if (response.status >= 400) {
          return Effect.fail(
            new WithingsError({
              message: `${what}: HTTP ${response.status}`,
              refused: response.status < 500 && response.status !== 429,
            })
          )
        }
        return json(what, response).pipe(
          Effect.mapError((error) => new WithingsError({ message: error.message, refused: false })),
          Effect.flatMap((answer) => checked(what, answer))
        )
      })
    )
}
