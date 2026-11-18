import { ManagedRuntime, type Layer } from 'effect'

import { App } from '../app.ts'

declare global {
  var garminRuntime:
    | ManagedRuntime.ManagedRuntime<Layer.Success<typeof App>, Layer.Error<typeof App>>
    | undefined
}

// Runs the jobs' Effects (see nitro.ts), the API's procedures (see api/) and the password check
// (see start.ts): the whole process shares one SQLite connection, the only writer. On globalThis,
// so `vite dev` re-evaluations reuse it, and for the Nitro plugin (bundled apart from the routes)
// to close it on shutdown.
globalThis.garminRuntime ??= ManagedRuntime.make(App)
export const runtime = globalThis.garminRuntime
