import process from 'node:process'

import { Console, Effect, Option, Redacted } from 'effect'
import { Command, Flag, Prompt } from 'effect/cli'

import { Garmin } from '../app.ts'
import { runMain } from '../main.ts'

import { GarminApi } from './api.ts'
import { explain, GarminLogin } from './login.ts'
import { GarminSession } from './session.ts'
import { GarminSync } from './sync.ts'

// The Garmin account from a terminal, like the web app's /garmin page:
//   node src/garmin/cli.ts login                    email, password, MFA code; saves the session
//   node src/garmin/cli.ts status                   which account, until when
//   node src/garmin/cli.ts logout                   forgets the session
//   node src/garmin/cli.ts sync [--since YYYY-MM-DD|all]   all: the whole history, paced
// (`pnpm garmin <command>`; in the container: docker exec -it <container> node src/garmin/cli.ts login)

const fail = Effect.fnUntraced(function* (message: string) {
  yield* Console.error(message)
  process.exitCode = 1
})

const login = Command.make(
  'login',
  {},
  Effect.fn(
    function* () {
      const garmin = yield* GarminLogin
      const email = yield* Prompt.run(Prompt.String({ message: 'Garmin email' }))
      const password = yield* Prompt.run(Prompt.Password({ message: 'Garmin password' }))
      const started = yield* garmin.start({ email, password: Redacted.value(password) })
      let account = started._tag === 'LoggedIn' ? started.account : null
      if (started._tag === 'NeedsMfa') {
        const code = yield* Prompt.run(
          Prompt.String({
            message: `MFA code (Garmin's ${started.method === 'email' ? 'email' : 'app'})`,
          })
        )
        account = yield* garmin.mfa(started.id, code)
      }
      const session = yield* GarminSession
      yield* Console.log(
        `Logged in as ${account?.full_name ?? account?.display_name ?? '?'}; session saved in ${session.path}.`
      )
      yield* Console.log('The app syncs within a minute (or run `pnpm garmin sync` now).')
    },
    Effect.catchTag(['LoginRefused', 'RateLimited', 'NotLoggedIn', 'GarminError'], (error) =>
      fail(explain(error))
    )
  )
).pipe(Command.withDescription('Log the Garmin account in and save its session'))

const status = Command.make(
  'status',
  {},
  Effect.fn(
    function* () {
      const garmin = yield* GarminLogin
      const current = yield* garmin.status
      if (!current.logged_in) return yield* fail('Not logged in: `pnpm garmin login`.')
      // Asks Garmin, so a revoked session shows
      const account = yield* GarminApi.use((api) => api.profile)
      yield* Console.log(
        `Logged in as ${account.full_name ?? account.display_name}; token valid until ${current.expires_at ?? '?'} (refreshed before).`
      )
    },
    Effect.catchTag(['NotLoggedIn', 'RateLimited', 'GarminError'], (error) =>
      fail(`Session refused: ${error.message}`)
    )
  )
).pipe(Command.withDescription('Which Garmin account is logged in, is its session valid'))

const logout = Command.make(
  'logout',
  {},
  Effect.fn(function* () {
    const session = yield* GarminSession
    yield* session.clear
    yield* Console.log(`Session forgotten (${session.path} removed).`)
  })
).pipe(Command.withDescription('Forget the Garmin session'))

const sync = Command.make(
  'sync',
  {
    since: Flag.String('since').pipe(
      Flag.withDescription('YYYY-MM-DD: fetch again from this day; all: the whole history'),
      Flag.optional
    ),
  },
  Effect.fn(function* ({ since }) {
    if (Option.isSome(since) && !/^(\d{4}-\d{2}-\d{2}|all)$/u.test(since.value)) {
      return yield* fail('--since takes a day (YYYY-MM-DD) or all')
    }
    const outcome = yield* GarminSync.use((service) =>
      service.run(Option.isSome(since) ? { since: since.value } : {})
    )
    for (const warning of outcome.warnings) yield* Console.error(`warning: ${warning}`)
    if (!outcome.ok) return yield* fail(`Sync failed: ${outcome.error ?? ''}`)
    yield* Console.log(
      `Synced ${outcome.account ?? '?'} from ${outcome.since ?? '?'}: ${outcome.files_written} file(s) written.`
    )
  })
).pipe(Command.withDescription('Sync Garmin Connect into DATA_DIR and DATABASE_PATH now'))

const garmin = Command.make('garmin').pipe(
  Command.withDescription('The Garmin account: login, status, logout, sync'),
  Command.withSubcommands([login, status, logout, sync])
)

if (import.meta.main) {
  garmin.pipe(Command.run({ version: '1.0.0' }), Effect.provide(Garmin), runMain)
}
