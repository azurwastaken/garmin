import { createFileRoute } from '@tanstack/react-router'

import { Terrain, tileResponse } from '#src/races/terrain.ts'
import { runtime } from '#src/server/runtime.ts'

// data/ortho read-only, for the race page's 3D map: an area's tiles.json and its aerial photos
// (see races/terrarium.ts orthoFile for the only paths served), behind the web session
export const Route = createFileRoute('/ortho/$')({
  server: {
    handlers: {
      GET: async ({ params }) =>
        tileResponse(
          await runtime.runPromise(Terrain.use((terrain) => terrain.photo(params._splat ?? '')))
        ),
    },
  },
})
