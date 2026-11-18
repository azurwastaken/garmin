import { createFileRoute } from '@tanstack/react-router'
import { Effect, Option } from 'effect'

import { publicOrigin } from '#src/auth.ts'
import { runtime } from '#src/server/runtime.ts'
import { WithingsSession } from '#src/withings/session.ts'

// Withings' consent page, behind the web session: it comes back to /withings/callback, the exact
// address to register as the developer app's callback
export const Route = createFileRoute('/withings/connect')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const location = await runtime.runPromise(
          WithingsSession.use((session) =>
            Option.match(session.app, {
              onNone: () => Effect.succeed('/garmin?withings=off'),
              onSome: (app) => app.authorize(`${publicOrigin(request)}/withings/callback`),
            })
          )
        )
        return new Response(null, { status: 302, headers: { location } })
      },
    },
  },
})
