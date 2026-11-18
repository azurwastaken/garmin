import { describe, expect, it } from 'vitest'

import {
  authorizeUrl,
  expiresSoon,
  fetchRange,
  monthFiles,
  syncMonths,
  tokensOf,
  withingsBody,
} from './measures.ts'

// One getmeas group: measures given as [type, value, unit]
const group = (
  date: string,
  measures: ReadonlyArray<readonly [number, number, number]>,
  extra: Record<string, unknown> = {}
) => ({
  grpid: Date.parse(date) / 1000,
  attrib: 0,
  date: Date.parse(date) / 1000,
  created: Date.parse(date) / 1000,
  modified: Date.parse(date) / 1000,
  category: 1,
  deviceid: 'scale',
  measures: measures.map(([type, value, unit]) => ({ type, value, unit, algo: 0, fm: 3 })),
  ...extra,
})

const file = (month: string, groups: ReadonlyArray<unknown>, timezone = 'Europe/Paris') => ({
  month,
  timezone,
  measuregrps: groups,
})

describe('authorizeUrl', () => {
  it("asks Withings for the body measures, back to the app's callback", () => {
    const url = new URL(
      authorizeUrl({ clientId: 'client', redirectUri: 'https://app/withings/callback', state: 's' })
    )
    expect(url.origin + url.pathname).toBe('https://account.withings.com/oauth2_user/authorize2')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: 'code',
      client_id: 'client',
      scope: 'user.metrics',
      redirect_uri: 'https://app/withings/callback',
      state: 's',
    })
  })
})

describe('syncMonths', () => {
  it('fetches the whole history when nothing is stored', () => {
    const wanted = syncMonths(null, '2026-11-16')
    expect(wanted[0]).toBe('2009-01')
    expect(wanted.at(-1)).toBe('2026-11')
    expect(wanted).toHaveLength(17 * 12 + 11)
  })

  it('fetches last month again, the user may still change it', () => {
    expect(syncMonths('2026-11', '2026-11-16')).toEqual(['2026-10', '2026-11'])
    expect(syncMonths('2026-11', '2026-11-30')).toEqual(['2026-10', '2026-11'])
    expect(syncMonths('2027-01', '2027-01-02')).toEqual(['2026-12', '2027-01'])
    // After a month shorter than 31 days
    expect(syncMonths('2026-03', '2026-03-01')).toEqual(['2026-02', '2026-03'])
    expect(syncMonths('2026-05', '2026-05-01')).toEqual(['2026-04', '2026-05'])
  })

  it('resumes from the last month stored after a gap', () => {
    expect(syncMonths('2026-08', '2026-11-16')).toEqual([
      '2026-08',
      '2026-09',
      '2026-10',
      '2026-11',
    ])
  })
})

describe('fetchRange', () => {
  it('starts a day before the first month, to cover its local midnight', () => {
    expect(fetchRange(['2026-10', '2026-11'], Date.parse('2026-11-16T10:00:00Z'))).toEqual({
      startdate: Date.parse('2026-09-30T00:00:00Z') / 1000,
      enddate: Date.parse('2026-11-16T10:00:00Z') / 1000,
    })
  })
})

describe('monthFiles', () => {
  it('files each group under the month of its local day, every month wanted', () => {
    // 23:30 UTC on Oct 31 is Nov 1 in Paris
    const late = group('2026-10-31T23:30:00Z', [[1, 70_100, -3]])
    const october = group('2026-10-15T07:00:00Z', [[1, 70_500, -3]])
    const before = group('2026-09-30T07:00:00Z', [[1, 71_000, -3]])
    const files = monthFiles([late, october, before, { no: 'date' }], 'Europe/Paris', [
      '2026-10',
      '2026-11',
      '2026-12',
    ])
    expect(files).toEqual([
      file('2026-10', [october]),
      file('2026-11', [late]),
      file('2026-12', []),
    ])
  })
})

describe('withingsBody', () => {
  it('reads a weigh-in: value × 10^unit, hydration as a percentage, rounded', () => {
    const json = file('2026-11', [
      group('2026-11-16T06:12:00Z', [
        [1, 70_355, -3],
        [6, 18_123, -3],
        [76, 54_32, -2],
        [77, 39_51, -2],
        [88, 287, -2],
        [170, 6, 0],
      ]),
    ])
    expect(withingsBody(json)).toEqual({
      start: '2026-11-01',
      end: '2026-11-30',
      rows: [
        {
          time: '2026-11-16T06:12:00.000Z',
          day: '2026-11-16',
          weight_kg: 70.36,
          bmi: null,
          body_fat_pct: 18.12,
          body_water_pct: 56.16,
          muscle_mass_kg: 54.32,
          bone_mass_kg: 2.87,
          visceral_fat: 6,
          source: 'WITHINGS',
        },
      ],
    })
  })

  it("keeps only the user's real weigh-ins of the month", () => {
    const json = file('2026-11', [
      group('2026-11-01T07:00:00Z', [[1, 70, 0]]),
      // a goal, someone else on the scale, no weight, last month's day in Paris
      group('2026-11-02T07:00:00Z', [[1, 65, 0]], { category: 2 }),
      group('2026-11-03T07:00:00Z', [[1, 90, 0]], { attrib: 1 }),
      group('2026-11-04T07:00:00Z', [[6, 18, 0]]),
      group('2026-10-31T22:30:00Z', [[1, 71, 0]]),
      { not: 'a group' },
    ])
    expect(withingsBody(json)?.rows.map((row) => row.weight_kg)).toEqual([70])
  })

  it('merges the groups of one instant, the last modified winning', () => {
    const at = '2026-11-16T06:12:00Z'
    const modified = Date.parse(at) / 1000
    const json = file('2026-11', [
      group(
        at,
        [
          [1, 70.2, 0],
          [6, 19, 0],
        ],
        { modified: modified + 60 }
      ),
      group(at, [[1, 70.4, 0]], { modified }),
    ])
    expect(withingsBody(json)?.rows).toMatchObject([{ weight_kg: 70.2, body_fat_pct: 19 }])
  })

  it('takes the day in Paris when the time zone is not one', () => {
    const json = file('2026-11', [group('2026-10-31T23:30:00Z', [[1, 70, 0]])], 'Not/AZone')
    expect(withingsBody(json)?.rows).toMatchObject([{ day: '2026-11-01' }])
  })

  it('refuses a file that is not a month', () => {
    expect(withingsBody({ month: '2026-13', timezone: 'UTC', measuregrps: [] })).toBeNull()
    expect(withingsBody([])).toBeNull()
  })
})

describe('tokens', () => {
  const now = Date.parse('2026-11-16T10:00:00Z')

  it('reads requesttoken, a numeric userid as a string', () => {
    const tokens = tokensOf(
      {
        userid: 1234,
        access_token: 'a',
        refresh_token: 'r',
        expires_in: 10_800,
        scope: 'user.metrics',
      },
      now
    )
    expect(tokens).toEqual({
      access_token: 'a',
      refresh_token: 'r',
      user_id: '1234',
      expires_at: '2026-11-16T13:00:00.000Z',
    })
    expect(tokensOf({ access_token: 'a' }, now)).toBeNull()
  })

  it('refreshes 15 minutes before the expiry', () => {
    const tokens = {
      access_token: 'a',
      refresh_token: 'r',
      user_id: '1',
      expires_at: '2026-11-16T10:20:00.000Z',
    }
    expect(expiresSoon(tokens, now)).toBe(false)
    expect(expiresSoon(tokens, now + 6 * 60 * 1000)).toBe(true)
    expect(expiresSoon({ ...tokens, expires_at: 'never' }, now)).toBe(true)
  })
})
