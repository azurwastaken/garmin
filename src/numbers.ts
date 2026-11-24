// Number helpers shared by the ingest, the MCP tools and the pages' queries

export const round = (value: number | null | undefined, digits = 0) =>
  value === null || value === undefined ? null : Number(value.toFixed(digits))

export const mean = (values: ReadonlyArray<number>) =>
  values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length

// The middle value, the mean of the two middle ones for an even count
export const median = (values: ReadonlyArray<number>) => {
  const sorted = values.toSorted((a, b) => a - b)
  const half = Math.floor(sorted.length / 2)
  if (sorted.length === 0) return null
  return sorted.length % 2 === 1
    ? (sorted[half] ?? null)
    : ((sorted[half - 1] ?? 0) + (sorted[half] ?? 0)) / 2
}

// The population standard deviation, of 2 values or more
export const spread = (values: ReadonlyArray<number>) => {
  const average = mean(values)
  if (average === null || values.length < 2) return null
  return Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / values.length)
}

// The values that are there
export const present = <A>(values: ReadonlyArray<A | null>) =>
  values.filter((value): value is A => value !== null)

// 1:02:05 or 42:05, from seconds
export const clock = (seconds: number) => {
  const whole = Math.round(seconds)
  const h = Math.floor(whole / 3600)
  const m = Math.floor((whole % 3600) / 60)
  const s = String(whole % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`
}
