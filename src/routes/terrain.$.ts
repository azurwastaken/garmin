import { createFileRoute } from '@tanstack/react-router'
import { Option } from 'effect'

import { Terrain } from '#src/races/terrain.ts'
import { runtime } from '#src/server/runtime.ts'

// data/terrain read-only, for the race page's 3D map: an area's tiles.json and its elevation tiles
// (see races/terrarium.ts terrainFile for the only paths served), behind the web session
export const Route = createFileRoute('/terrain/$')({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const found = await runtime.runPromise(
          Terrain.use((terrain) => terrain.file(params._splat ?? ''))
        )
        return Option.match(found, {
          onNone: () => new Response('Not found\n', { status: 404 }),
          onSome: ({ bytes, type }) =>
            new Response(new Uint8Array(bytes), {
              headers: {
                'content-type': type,
                // Its own: start.ts's default is no-store, and a map asks for hundreds of tiles
                'cache-control': 'private, max-age=86400',
              },
            }),
        })
      },
    },
  },
})
