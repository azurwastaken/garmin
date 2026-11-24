import type { Prescribed } from './program.ts'

// The pain rule, without I/O: an exercise that loads a structure pinned on the body map with a
// pain at the programme's threshold or more (3/10) in its window (14 days) takes its regression

export interface RecentPain {
  readonly structure: string
  readonly day: string
  readonly pain: number
}

export interface PainFlag {
  readonly exercise_id: string
  readonly exercise: string
  // The loaded structures in pain, the worst first: its highest pain and that day
  readonly structures: ReadonlyArray<{
    readonly structure: string
    readonly role: 'primary' | 'secondary'
    readonly pain: number
    readonly day: string
  }>
  readonly regression: string
}

// Each structure's worst pain of `pains` (the latest day on a tie)
export const worstPains = (pains: ReadonlyArray<RecentPain>): ReadonlyMap<string, RecentPain> => {
  const worst = new Map<string, RecentPain>()
  for (const pain of pains) {
    const known = worst.get(pain.structure)
    if (
      known === undefined ||
      pain.pain > known.pain ||
      (pain.pain === known.pain && pain.day > known.day)
    ) {
      worst.set(pain.structure, pain)
    }
  }
  return worst
}

// The exercises the rule regresses, in the session's order; `pains` are the window's already
export const painFlags = (
  exercises: ReadonlyArray<
    Pick<Prescribed, 'id' | 'name' | 'primary' | 'secondary' | 'regression'>
  >,
  pains: ReadonlyArray<RecentPain>,
  threshold: number
): Array<PainFlag> => {
  const worst = worstPains(pains)
  return exercises.flatMap((exercise) => {
    const loaded = [
      ...exercise.primary.map((structure) => ({ structure, role: 'primary' as const })),
      ...exercise.secondary.map((structure) => ({ structure, role: 'secondary' as const })),
    ].flatMap(({ structure, role }) => {
      const pain = worst.get(structure)
      return pain === undefined || pain.pain < threshold
        ? []
        : [{ structure, role, pain: pain.pain, day: pain.day }]
    })
    return loaded.length === 0
      ? []
      : [
          {
            exercise_id: exercise.id,
            exercise: exercise.name,
            structures: loaded.toSorted((a, b) => b.pain - a.pain),
            regression: exercise.regression,
          },
        ]
  })
}

// Each structure the exercises load, primary over secondary
export const workedStructures = (
  exercises: ReadonlyArray<Pick<Prescribed, 'primary' | 'secondary'>>
): ReadonlyMap<string, 'primary' | 'secondary'> => {
  const worked = new Map<string, 'primary' | 'secondary'>()
  for (const exercise of exercises) {
    for (const id of exercise.secondary) if (!worked.has(id)) worked.set(id, 'secondary')
  }
  for (const exercise of exercises) for (const id of exercise.primary) worked.set(id, 'primary')
  return worked
}
