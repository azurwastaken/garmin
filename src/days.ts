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

// shortcut: stats.ts keeps its own mondayOf and minutesFromNoon (it imports the nutrition module,
// so importing from it would close a cycle, and the sleep branch edits it): fold them into these
// once jarvis-sleep lands

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
