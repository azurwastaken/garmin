import { createFileRoute } from '@tanstack/react-router'

import { Anatomy, anatomyFile, anatomyResponse } from '#src/anatomy/anatomy.ts'
import { runtime } from '#src/server/runtime.ts'

// The body map's model and catalog (see anatomy/anatomy.ts), behind the web session like every
// page: only these two files, whatever the path asked
export const Route = createFileRoute('/anatomy/$file')({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const file = anatomyFile(params.file)
        if (file === null) return anatomyResponse({ _tag: 'Missing' })
        const answer = await runtime.runPromise(
          Anatomy.use((anatomy) => anatomy.file(file, request.headers.get('if-none-match')))
        )
        return anatomyResponse(answer)
      },
    },
  },
})
