// The spans the runs, sleep, body and nutrition pages offer (and their procedures take): no server
// code, for the browser's bundle
export const RUNS_SPANS = [26, 52, 'all'] as const
export const SLEEP_PERIODS = [30, 90, 365, 'all'] as const
export const BODY_PERIODS = [7, 30, 90] as const
export const NUTRITION_SPANS = [90, 365] as const
// The sleep page's analysis reads this many days at least: 30 make buckets of 5 nights rare
export const INSIGHT_MIN_DAYS = 90
