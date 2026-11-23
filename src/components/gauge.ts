import type { Measure } from '#src/today.ts'

// The Today gauge's numbers, without I/O: where tonight's value sits on the verdict's own scale,
// and the limit as the legend shows it

// 0.5 on the normal, 0.25 on the verdict's limit, toward 0 worse, toward 1 better, clamped. The
// limit is at least 2.5 from the rounded normal, never on it.
export const measureFraction = ({ value, normal, limit }: Measure) =>
  Math.min(1, Math.max(0, 0.5 - (0.25 * (value - normal)) / (limit - normal)))

// The limit to 0.1, rounded away from the normal: a whole-number reading is past the shown limit
// exactly when it is past the real one, so the legend never contradicts the light
export const shownLimit = ({ limit, normal }: Pick<Measure, 'limit' | 'normal'>) =>
  (limit < normal ? Math.floor : Math.ceil)(limit * 10) / 10
