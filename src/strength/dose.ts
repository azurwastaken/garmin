// A prescribed exercise's dose in words, without imports: the browser shows it too

// "3 × 10 par côté · tempo 3-0-3", "3 × 20 s par côté"
export const doseLabel = (exercise: {
  readonly sets: number
  readonly reps: number | null
  readonly seconds: number | null
  readonly per_side: boolean
  readonly tempo: string | null
}) =>
  [
    `${exercise.sets} × ${exercise.reps ?? `${exercise.seconds ?? 0} s`}${exercise.per_side ? ' par côté' : ''}`,
    exercise.tempo === null ? null : `tempo ${exercise.tempo}`,
  ]
    .filter((part) => part !== null)
    .join(' · ')
