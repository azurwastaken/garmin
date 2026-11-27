import { Layer } from 'effect'

import { Anatomy } from './anatomy/anatomy.ts'
import { Auth } from './auth.ts'
import { Caffeine } from './caffeine/caffeine.ts'
import { GarminApi } from './garmin/api.ts'
import { GarminLogin } from './garmin/login.ts'
import { GarminSession } from './garmin/session.ts'
import { GarminSync } from './garmin/sync.ts'
import { GarminWorkouts } from './garmin/workouts.ts'
import { Ingest, Storage } from './ingest.ts'
import { Journal } from './journal/log.ts'
import { Platform } from './main.ts'
import { Meals } from './meals/meals.ts'
import { Nutrition } from './nutrition/nutrition.ts'
import { OAuth } from './oauth/oauth.ts'
import { Races } from './races/races.ts'
import { Terrain } from './races/terrain.ts'
import { Reader } from './reader.ts'
import { Stats } from './stats.ts'
import { Strength } from './strength/strength.ts'
import { Tools } from './tools.ts'
import { WithingsSession } from './withings/session.ts'
import { WithingsSync } from './withings/sync.ts'

// The app's layers, composed once: the server, the CLIs, scripts and tests pick the part they need.
// Each part leaves the platform (files, child processes, HTTP) and the config open, so a test gives
// it a stubbed HTTP client and a temporary directory; `App` and main.ts's `runMain` give it Node's.

// SQLite and the ingest of data/ into it, defined beside the ingest's CLI (see ingest.ts)
export { Storage } from './ingest.ts'

// The Garmin account: its session (a file of its own), the API, the sync into data/ and SQLite,
// the login (web and CLI), the workouts written to its calendar (the MCP's)
export const Garmin = Layer.merge(GarminLogin.layer, GarminWorkouts.layer).pipe(
  Layer.provideMerge(GarminSync.layer),
  Layer.provideMerge(GarminApi.layer),
  Layer.provideMerge(GarminSession.layer),
  Layer.provideMerge(Storage)
)

// The Withings account (a scale's weigh-ins): its session (a file of its own), its sync into data/
// and SQLite, on a loop of its own
export const Withings = WithingsSync.layer.pipe(
  Layer.provideMerge(WithingsSession.layer),
  Layer.provideMerge(Storage)
)

// Everything the server runs: Garmin, Withings, the MCP's and the web pages' queries, the journal,
// the caffeine tracker, the meal log, the races (their files and the elevation tiles), the
// nutrition plan and the weight trend, the strength programme and its sessions, the anatomy model
// of the body map, the password and the MCP's OAuth server. A layer is built once however many
// parts use it: Storage is one SQLite connection, the only writer.
export const Services = Layer.mergeAll(
  Garmin,
  Withings,
  Reader.layer,
  Tools.layer,
  Journal.layer,
  Caffeine.layer,
  Meals.layer,
  Races.layer.pipe(Layer.provideMerge(Terrain.layer)),
  Auth.layer,
  OAuth.layer
).pipe(
  // The caffeine tracker's bedtime is the sleep analysis's
  Layer.provideMerge(Stats.layer),
  Layer.provideMerge(Strength.layer),
  Layer.provideMerge(Nutrition.layer),
  Layer.provideMerge(Anatomy.layer),
  Layer.provideMerge(Storage)
)

// The server's layer, on Node
export const App = Services.pipe(Layer.provideMerge(Platform))

// The background jobs: the Garmin and Withings syncs every 3 hours (each ingests what it wrote),
// and the ingest of data/ every 5 minutes for what lands there otherwise (an export's backfill)
export const Jobs = Layer.mergeAll(GarminSync.scheduler, WithingsSync.scheduler, Ingest.scheduler)
