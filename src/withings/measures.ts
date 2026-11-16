import { DateTime, Option, Schema } from 'effect'

import { round, type BodyRow } from '../connect.ts'
import { addDays, monthEnd, monthOf, months } from '../days.ts'

// Withings' weigh-ins, without I/O: the authorization URL, the months a sync fetches, the getmeas
// groups filed by month (data/withings/YYYY-MM.json) and read back as rows of `body`, the tokens.
//
// A group is one weigh-in: its measures are value × 10^unit, by type. Category 1 is a real
// measure (2: a goal the user set); attrib 1 is a weigh-in the scale could not attribute (someone
// else in the house stepped on it), not the user's.

const AUTHORIZE_URL = 'https://account.withings.com/oauth2_user/authorize2'
// Weight (kg), fat ratio (%), muscle mass (kg), hydration (kg), bone mass (kg), visceral fat
export const MEASURE_TYPES = '1,6,76,77,88,170'
export const SOURCE = 'WITHINGS'
// The first Withings scales: the whole history starts there
const FIRST_MONTH = '2009-01'
export const TIME_ZONE = 'Europe/Paris'

export const authorizeUrl = ({
  clientId,
  redirectUri,
  state,
}: {
  readonly clientId: string
  readonly redirectUri: string
  readonly state: string
}) => {
  const url = new URL(AUTHORIZE_URL)
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    scope: 'user.metrics',
    redirect_uri: redirectUri,
    state,
  }).toString()
  return url.toString()
}

// The months (YYYY-MM) to fetch: the whole history when none is stored, else from the newest
// month stored (the last sync that completed) or last month (the user may still change it), to
// today's
export const syncMonths = (newestMonth: string | null, today: string) => {
  // A weigh-in edited, deleted or attributed in the app: last month's too
  const lastMonth = monthOf(addDays(monthOf(today), -1)).slice(0, 7)
  const from =
    newestMonth === null ? FIRST_MONTH : newestMonth < lastMonth ? newestMonth : lastMonth
  return months(`${from}-01`, today).map((month) => month.slice(0, 7))
}

// getmeas' span for these months (unix seconds): a day before the first one at 00:00 UTC (its
// local midnight, east of UTC), to now
export const fetchRange = (wanted: ReadonlyArray<string>, nowMs: number) => {
  const enddate = Math.floor(nowMs / 1000)
  const first = wanted[0]
  return {
    startdate: first === undefined ? enddate : Date.parse(`${first}-01T00:00:00Z`) / 1000 - 86_400,
    enddate,
  }
}

// The local day of an instant (unix seconds) in Withings' time zone, Paris when it is not one
const localDay = (epochS: number, timeZone: string) =>
  DateTime.makeZoned(epochS * 1000, { timeZone }).pipe(
    Option.orElse(() => DateTime.makeZoned(epochS * 1000, { timeZone: TIME_ZONE })),
    Option.map(DateTime.formatIsoDate),
    Option.getOrElse(() => new Date(epochS * 1000).toISOString().slice(0, 10))
  )

const Dated = Schema.Struct({ date: Schema.Finite })
const decodeDated = Schema.decodeUnknownOption(Dated)

export interface MonthFile {
  readonly month: string
  readonly timezone: string
  readonly measuregrps: ReadonlyArray<unknown>
}

// getmeas' groups as they came, filed by the month of their local day: a file for every month
// wanted, an empty one too (it says the month was fetched); a group without a date is dropped
export const monthFiles = (
  groups: ReadonlyArray<unknown>,
  timezone: string,
  wanted: ReadonlyArray<string>
): ReadonlyArray<MonthFile> => {
  const byMonth = new Map<string, Array<unknown>>(wanted.map((month) => [month, []]))
  for (const group of groups) {
    const dated = decodeDated(group)
    if (Option.isNone(dated)) continue
    byMonth.get(localDay(dated.value.date, timezone).slice(0, 7))?.push(group)
  }
  return wanted.map((month) => ({ month, timezone, measuregrps: byMonth.get(month) ?? [] }))
}

const MeasureGroup = Schema.Struct({
  date: Schema.Finite,
  category: Schema.Finite,
  attrib: Schema.optional(Schema.NullOr(Schema.Finite)),
  modified: Schema.optional(Schema.NullOr(Schema.Finite)),
  measures: Schema.Array(
    Schema.Struct({ type: Schema.Finite, value: Schema.Finite, unit: Schema.Finite })
  ),
})
type Group = typeof MeasureGroup.Type
const decodeGroup = Schema.decodeUnknownOption(MeasureGroup)

const File = Schema.Struct({
  month: Schema.String.check(Schema.isPattern(/^\d{4}-(?:0[1-9]|1[0-2])$/u)),
  timezone: Schema.String,
  measuregrps: Schema.Array(Schema.Unknown),
})
const decodeFile = Schema.decodeUnknownOption(File)

const isUsers = (group: Group) => group.category === 1 && group.attrib !== 1

// value × 10^unit, divided for a negative unit: 1004 × 10^-2 would be 10.040000000000001
const scaled = ({ value, unit }: { readonly value: number; readonly unit: number }) =>
  unit < 0 ? value / 10 ** -unit : value * 10 ** unit

// The measures of each instant, by type: groups of the same second are one weigh-in, the one
// modified last winning a type both have
const measuresByInstant = (groups: ReadonlyArray<Group>) => {
  const byDate = new Map<number, Map<number, number>>()
  for (const group of groups.toSorted((a, b) => (a.modified ?? 0) - (b.modified ?? 0))) {
    const values = byDate.get(group.date) ?? new Map<number, number>()
    for (const m of group.measures) values.set(m.type, scaled(m))
    byDate.set(group.date, values)
  }
  return byDate
}

const bodyRow = (
  date: number,
  values: ReadonlyMap<number, number>,
  timezone: string
): BodyRow | null => {
  const weight = values.get(1)
  if (weight === undefined || weight <= 0) return null
  const water = values.get(77)
  return {
    time: new Date(date * 1000).toISOString(),
    day: localDay(date, timezone),
    weight_kg: round(weight, 2),
    bmi: null,
    body_fat_pct: round(values.get(6), 2),
    body_water_pct: water === undefined ? null : round((water / weight) * 100, 2),
    muscle_mass_kg: round(values.get(76), 2),
    bone_mass_kg: round(values.get(88), 2),
    visceral_fat: round(values.get(170), 2),
    source: SOURCE,
  }
}

// A month file's weigh-ins of the user, in its month, and the month's days (its rows replace
// the Withings rows of those days); null for a file that is not one
export const withingsBody = (json: unknown) =>
  Option.match(decodeFile(json), {
    onNone: () => null,
    onSome: (file) => {
      const groups = file.measuregrps
        .flatMap((raw) => Option.toArray(decodeGroup(raw)))
        .filter((group) => isUsers(group))
      const rows = [...measuresByInstant(groups)]
        .map(([date, values]) => bodyRow(date, values, file.timezone))
        .filter((row): row is BodyRow => row !== null && row.day.startsWith(file.month))
      const start = `${file.month}-01`
      return { start, end: monthEnd(start), rows }
    },
  })

export const WithingsTokensJson = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.String,
  user_id: Schema.String,
  // ISO 8601
  expires_at: Schema.String,
})
export type WithingsTokens = typeof WithingsTokensJson.Type

const TokenAnswer = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.String,
  userid: Schema.Union([Schema.String, Schema.Finite]),
  expires_in: Schema.Finite,
})
const decodeTokenAnswer = Schema.decodeUnknownOption(TokenAnswer)

// requesttoken's answer (its body) as the tokens, their expiry from now
export const tokensOf = (body: unknown, nowMs: number): WithingsTokens | null =>
  Option.match(decodeTokenAnswer(body), {
    onNone: () => null,
    onSome: (answer) => ({
      access_token: answer.access_token,
      refresh_token: answer.refresh_token,
      user_id: String(answer.userid),
      expires_at: new Date(nowMs + answer.expires_in * 1000).toISOString(),
    }),
  })

// Refreshed 15 minutes before it expires (an unreadable expiry: now)
export const expiresSoon = (tokens: WithingsTokens, nowMs: number) => {
  const expiry = Date.parse(tokens.expires_at)
  return Number.isNaN(expiry) || expiry - nowMs < 15 * 60 * 1000
}
