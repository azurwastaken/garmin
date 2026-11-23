import { describe, expect, it } from 'vitest'

import { profileOf, segmentCourse } from './course.ts'
import { bestEffort, distanceAt, fuelling, riegel, timeAt, timeline } from './pacing.ts'

const profile = (d: Array<number>, ele: Array<number>) => {
  const made = profileOf(d, ele)
  if (made === null) throw new Error('no profile')
  return made
}

// 10 km flat, a 3 km climb of 300 m, 3 km down
const hilly = profile([0, 10_000, 13_000, 16_000], [100, 100, 400, 100])
const reference = { moving_s: 3000, equivalent_m: 10_000 }

describe('the pacing', () => {
  it('carries a time to another distance with Riegel', () => {
    expect(riegel(3000, 10_000, 10_000)).toBe(3000)
    expect(riegel(3000, 10_000, 21_097.5)).toBeCloseTo(3000 * 2.10975 ** 1.06, 6)
  })

  it('predicts from the run that carries best', () => {
    const runs = [
      { id: 1, moving_s: 3000, equivalent_m: 10_000 },
      { id: 2, moving_s: 1200, equivalent_m: 4000 },
      { id: 3, moving_s: 7000, equivalent_m: 21_000 },
    ]
    // 1200 s / 4 km carries to the fastest 10 km: 1200 × 2.5^1.06 ≈ 3166 > 3000
    expect(bestEffort(runs)?.id).toBe(1)
    expect(bestEffort([])).toBeNull()
  })

  it("splits the model's time by effort, monotonic to its total", () => {
    const segments = segmentCourse(hilly)
    const line = timeline(hilly, segments, reference, new Map())
    const total = line.at(-1)?.t ?? 0
    expect(line.every((p, i) => i === 0 || p.t > (line[i - 1]?.t ?? 0))).toBe(true)
    expect(line[0]?.t).toBe(0)
    expect(total).toBeGreaterThan(riegel(3000, 10_000, 16_000))
    // Uphill slower than flat, by the GAP factor
    const flatPace = timeAt(line, 5000) / 5
    const climbPace = (timeAt(line, 12_500) - timeAt(line, 11_000)) / 1.5
    expect(climbPace / flatPace).toBeGreaterThan(1.4)
  })

  it("gives a planned pace's time to its segment", () => {
    const segments = segmentCourse(hilly)
    const climb = segments.find((s) => s.kind === 'climb')
    if (climb === undefined) throw new Error('no climb')
    const line = timeline(hilly, segments, reference, new Map([[climb.index, 600]]))
    const spent = timeAt(line, climb.to_km * 1000) - timeAt(line, climb.from_km * 1000)
    expect(spent).toBeCloseTo(600 * climb.km, 6)
    expect(distanceAt(line, timeAt(line, 12_345))).toBeCloseTo(12_345, 6)
  })

  it('places a gel every 25 minutes at 60 g/h, and water by the hour', () => {
    const segments = segmentCourse(hilly)
    const line = timeline(hilly, segments, reference, new Map())
    const total = line.at(-1)?.t ?? 0
    const plan = fuelling(line, segments, {
      carbs_g_per_h: 60,
      gel_carbs_g: 25,
      water_ml_per_h: 500,
    })
    expect(plan.gels.map((gel) => gel.at_s)).toEqual(
      Array.from({ length: Math.ceil(total / 1500) - 1 }, (_, k) => (k + 1) * 1500)
    )
    expect(plan.gels.every((gel, i) => i === 0 || gel.km > (plan.gels[i - 1]?.km ?? 0))).toBe(true)
    expect(plan.per_segment.reduce((sum, s) => sum + s.gels, 0)).toBe(plan.gels.length)
    expect(plan.per_segment.reduce((sum, s) => sum + s.water_ml, 0)).toBeCloseTo(
      (500 * total) / 3600,
      6
    )
    expect(
      fuelling(line, segments, { carbs_g_per_h: 0, gel_carbs_g: 25, water_ml_per_h: 0 }).gels
    ).toEqual([])
  })
})
