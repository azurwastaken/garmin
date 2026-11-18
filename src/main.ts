import * as NodeRuntime from '@effect/platform-node/NodeRuntime'
import * as NodeServices from '@effect/platform-node/NodeServices'
import { Effect, Layer } from 'effect'
import { FetchHttpClient } from 'effect/http'

// Node's file system, path, child processes and terminal, and fetch for HTTP: what the app's
// layers (see app.ts) leave open, so a test can give them a stubbed HTTP client instead
export const Platform = Layer.merge(NodeServices.layer, FetchHttpClient.layer)

// Runs a one-off program (a CLI, a script) as the process's main, over `layer` and the Node
// platform: the layer is built for it and released after, a failure is logged and exits 1, Ctrl-C
// interrupts it. Pass the smallest part of app.ts that covers it, e.g. a script listing the
// workout library:
//   runMain(GarminWorkouts.use((workouts) => workouts.library({})).pipe(Effect.tap(Console.log)), Garmin)
export const runMain = <A, E, ROut, LE>(
  program: Effect.Effect<A, E, NoInfer<ROut> | Layer.Success<typeof Platform>>,
  layer: Layer.Layer<ROut, LE, Layer.Success<typeof Platform>>
) => NodeRuntime.runMain(program.pipe(Effect.provide(Layer.provideMerge(layer, Platform))))
