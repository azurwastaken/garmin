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
