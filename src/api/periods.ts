// The spans the runs, sleep, body and nutrition pages offer (and their procedures take), and the
// sleep page's analysis thresholds: no server code, for the browser's bundle
export const RUNS_SPANS = [26, 52, 'all'] as const
export const SLEEP_PERIODS = [30, 90, 365, 'all'] as const
export const BODY_PERIODS = [7, 30, 90] as const
export const NUTRITION_SPANS = [90, 365] as const
// The sleep page's analysis reads this many days at least: 30 make buckets of 5 nights rare
export const INSIGHT_MIN_DAYS = 90
// Under this many values, no mean and no spread: too few nights to say anything
export const MIN_NIGHTS = 5
// The before side of a "since" comparison: the 28 days before the first night after
export const TAG_BEFORE_DAYS = 28
