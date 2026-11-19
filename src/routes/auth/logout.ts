import { createFileRoute } from '@tanstack/react-router'

import { Auth, seeOther, sessionCookie } from '#src/auth.ts'
import { runtime } from '#src/server/runtime.ts'

// Logs every browser out (behind the gate: only with a session), and forgets this one's cookie
export const Route = createFileRoute('/auth/logout')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        // Failing, this browser is logged out all the same
        await runtime
          .runPromise(Auth.use((auth) => auth.logout))
          .catch((error: unknown) => console.error('logout', error))
        return seeOther('/login', {
          'set-cookie': sessionCookie(request, { value: '', maxAge: 0 }),
        })
      },
    },
  },
})
