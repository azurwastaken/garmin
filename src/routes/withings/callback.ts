import { createFileRoute } from '@tanstack/react-router'

import { runtime } from '#src/server/runtime.ts'
import { connectFromCallback } from '#src/withings/sync.ts'

// Where Withings sends the user back, behind the web session (the browser's cookie comes with
// the redirect): its code traded at once, then back to /garmin, which says how it went
export const Route = createFileRoute('/withings/callback')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const query = new URL(request.url).searchParams
        const result = await runtime.runPromise(
          connectFromCallback({
            code: query.get('code'),
            state: query.get('state'),
            error: query.get('error'),
          })
        )
        return new Response(null, {
          status: 303,
          headers: { location: `/garmin?withings=${result}` },
        })
      },
    },
  },
})
