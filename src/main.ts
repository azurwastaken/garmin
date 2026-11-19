import * as NodeRuntime from '@effect/platform-node/NodeRuntime'
import * as NodeServices from '@effect/platform-node/NodeServices'
import { Effect, Layer } from 'effect'
import { FetchHttpClient } from 'effect/http'

// Node's file system, path, child processes and terminal, and fetch for HTTP: what the app's
// layers (see app.ts) leave open, so a test can give them a stubbed HTTP client instead
export const Platform = Layer.merge(NodeServices.layer, FetchHttpClient.layer)

// Runs a one-off program (a CLI, a script) on Node as the process's main: a failure is logged and
// exits 1, Ctrl-C interrupts it. The program brings its part of app.ts first:
//   program.pipe(Effect.provide(Garmin), runMain)
export const runMain = <A, E>(program: Effect.Effect<A, E, Layer.Success<typeof Platform>>) =>
  NodeRuntime.runMain(program.pipe(Effect.provide(Platform)))
