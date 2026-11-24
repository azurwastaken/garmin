import { DateTime, Effect, Option } from 'effect'

// Days as YYYY-MM-DD strings, months as the first day of theirs

export const addDays = (day: string, days: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10)
export const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000)
export const earlierDay = (a: string, b: string) => (a < b ? a : b)

// Today in Paris time, the user's days
export const parisToday = Effect.map(DateTime.now, (now) =>
  DateTime.makeZoned(now, { timeZone: 'Europe/Paris' }).pipe(
    Option.map(DateTime.formatIsoDate),
    Option.getOrElse(() => DateTime.formatIsoDate(now))
  )
)

// The instant (epoch ms) of a Paris wall time (HH:MM) on a day; a time the clocks skip moves later,
// a day that does not exist (02-30) is none
export const parisInstant = (day: string, clock: string) =>
  DateTime.makeZoned(
    {
      year: Number(day.slice(0, 4)),
      month: Number(day.slice(5, 7)),
      day: Number(day.slice(8, 10)),
      hour: Number(clock.slice(0, 2)),
      minute: Number(clock.slice(3, 5)),
    },
    { timeZone: 'Europe/Paris', adjustForTimeZone: true }
  ).pipe(
    Option.map(DateTime.toEpochMillis),
    Option.filter((at) => parisWall(at).day === day)
  )

const parisParts = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Paris',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

// An instant's day and wall clock (HH:MM) in Paris
export const parisWall = (at: number) => {
  const parts = Object.fromEntries(
    parisParts.formatToParts(at).map((part) => [part.type, part.value])
  )
  return {
    day: `${parts['year']}-${parts['month']}-${parts['day']}`,
    clock: `${parts['hour']}:${parts['minute']}`,
  }
}

// Minutes after midnight of an HH:MM
export const minuteOf = (clock: string) =>
  Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5))

export const monthOf = (day: string) => `${day.slice(0, 7)}-01`
const nextMonth = (month: string) => {
  const date = new Date(`${month}T00:00:00Z`)
  date.setUTCMonth(date.getUTCMonth() + 1)
  return date.toISOString().slice(0, 10)
}
export const monthEnd = (month: string) => addDays(nextMonth(month), -1)
// The first day of each month from `from`'s to `to`'s
export const months = (from: string, to: string) => {
  const all: Array<string> = []
  for (let month = monthOf(from); month <= to; month = nextMonth(month)) all.push(month)
  return all
}

// The Monday of the ISO week of `day`
export const mondayOf = (day: string) =>
  addDays(day, -((new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7))

const parisClock = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Paris',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

// Minutes from noon in Paris time, so that a bedtime before and after midnight sorts on one axis
// (00:30 is 750); null for no instant or an unreadable one
export const parisMinutesFromNoon = (iso: string | null): number | null => {
  if (iso === null) return null
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return null
  const parts = parisClock.formatToParts(date)
  const hour = Number(parts.find((part) => part.type === 'hour')?.value)
  const minute = Number(parts.find((part) => part.type === 'minute')?.value)
  return (hour * 60 + minute - 720 + 1440) % 1440
}
