import { createFileRoute } from '@tanstack/react-router'

import { Terrain, tileResponse } from '#src/races/terrain.ts'
import { runtime } from '#src/server/runtime.ts'

// data/terrain read-only, for the race page's 3D map: an area's tiles.json and its elevation tiles
// (see races/terrarium.ts terrainFile for the only paths served), behind the web session
export const Route = createFileRoute('/terrain/$')({
  server: {
    handlers: {
      GET: async ({ params }) =>
        tileResponse(
          await runtime.runPromise(Terrain.use((terrain) => terrain.file(params._splat ?? '')))
        ),
    },
  },
})
