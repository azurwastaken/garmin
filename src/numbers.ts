// Number helpers shared by the ingest, the MCP tools and the pages' queries

export const round = (value: number | null | undefined, digits = 0) =>
  value === null || value === undefined ? null : Number(value.toFixed(digits))

export const mean = (values: ReadonlyArray<number>) =>
  values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length

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
