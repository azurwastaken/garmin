// The words of a pain pinned on the body map (see note.ts's NoteBody): no imports, for the
// browser's bundle. The values are the API's; the labels are the page's, in French.

export const SIDES = ['left', 'right', 'midline'] as const
export type Side = (typeof SIDES)[number]

export const PAIN_KINDS = [
  'vive',
  'sourde',
  'brulure',
  'raideur',
  'tiraillement',
  'pointe',
] as const
export type PainKind = (typeof PAIN_KINDS)[number]

export const PAIN_WHEN = [
  'effort',
  'descente',
  'cote',
  'repos',
  'nuit',
  'reveil',
  'escaliers',
  'palpation',
] as const
export type PainWhen = (typeof PAIN_WHEN)[number]

export const SIDE_LABEL: Record<Side, string> = {
  left: 'côté gauche',
  right: 'côté droit',
  midline: 'au milieu',
}

export const PAIN_KIND_LABEL: Record<PainKind, string> = {
  vive: 'vive',
  sourde: 'sourde',
  brulure: 'brûlure',
  raideur: 'raideur',
  tiraillement: 'tiraillement',
  pointe: 'pointe',
}

export const PAIN_WHEN_LABEL: Record<PainWhen, string> = {
  effort: "à l'effort",
  descente: 'en descente',
  cote: 'en côte',
  repos: 'au repos',
  nuit: 'la nuit',
  reveil: 'au réveil',
  escaliers: 'dans les escaliers',
  palpation: 'à la palpation',
}

// A kind as a note opens with it
const PAIN_KIND_PHRASE: Record<PainKind, string> = {
  vive: 'Douleur vive',
  sourde: 'Douleur sourde',
  brulure: 'Brûlure',
  raideur: 'Raideur',
  tiraillement: 'Tiraillement',
  pointe: 'Douleur en pointe',
}

// The note's text when the user wrote none: "Douleur vive 6/10, vaste latéral (quadriceps), côté
// droit : en descente, dans les escaliers."
export const painSummary = (
  body: { readonly pain: number; readonly kind: PainKind; readonly when: ReadonlyArray<PainWhen> },
  where: string
) => {
  const moments = body.when.map((moment) => PAIN_WHEN_LABEL[moment]).join(', ')
  return `${PAIN_KIND_PHRASE[body.kind]} ${body.pain}/10, ${where}${moments === '' ? '' : ` : ${moments}`}.`
}
