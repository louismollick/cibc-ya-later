import { describe, expect, it } from 'vitest'
import { bankDateRange, downloadRanges, emptyAccount, validateExport } from '../src/main/cibc'
import { parseOfx } from '../src/main/ofx'
import { ofx } from './helpers'

const now = new Date('2026-10-16T17:00:00Z')
describe('Export completeness', () => {
  it('accepts historical ledger dates without relaxing row coverage or future-balance checks', () => {
    const range = bankDateRange(60, now)
    const parsed = { ...parseOfx(ofx()), balanceDate: 1577836800 }
    expect(() => validateExport(parsed, range, now.getTime() / 1000, true)).not.toThrow()
    expect(() => validateExport(parsed, range, now.getTime() / 1000)).toThrow('old')
    expect(() =>
      validateExport(parsed, { ...range, start: range.end - 1 }, now.getTime() / 1000, true),
    ).toThrow('range')
    expect(() =>
      validateExport(
        { ...parsed, balanceDate: now.getTime() / 1000 + 2 * 86400 },
        range,
        now.getTime() / 1000,
        true,
      ),
    ).toThrow('invalid')
  })
  it('accepts CIBC timezone differences on the last posting day, but rejects rows on another day', () => {
    const range = bankDateRange(60, now)
    const parsed = parseOfx(
      Buffer.from(
        ofx()
          .toString()
          .replace('20261001120000', '20261010120000')
          .replace('20261015120000', '20261011120000')
          .replaceAll(/(<DTPOSTED>\d{14})/g, '$1.000[-5:EST]'),
      ),
    )
    expect(() => validateExport(parsed, range, now.getTime() / 1000)).not.toThrow()
    const first = parsed.transactions[0]
    if (!first) throw new Error('Missing fixture transaction')
    for (const date of ['2026-10-09T17:00:00Z', '2026-10-12T00:00:00Z']) {
      expect(() =>
        validateExport(
          {
            ...parsed,
            transactions: [{ ...first, posted: Date.parse(date) / 1000 }],
          },
          range,
          now.getTime() / 1000,
        ),
      ).toThrow('range')
    }
  })
  it('accepts first/last transaction dates while rejecting stale files and out-of-range rows', () => {
    const range = bankDateRange(60, now),
      parsed = parseOfx(ofx())
    expect(() => validateExport(parsed, range, now.getTime() / 1000)).not.toThrow()
    expect(() =>
      validateExport({ ...parsed, balanceDate: 1577836800 }, range, now.getTime() / 1000),
    ).toThrow('old')
    expect(() =>
      validateExport(
        parsed,
        { ...range, start: Date.parse('2026-10-12T00:00:00Z') / 1000 },
        now.getTime() / 1000,
      ),
    ).toThrow('range')
    expect(() =>
      validateExport({ ...parsed, exportEnd: parsed.exportStart - 1 }, range, now.getTime() / 1000),
    ).toThrow('range')
  })
  it('uses the same stable account ID for a CIBC 0121 empty response and a later OFX export', () => {
    const empty = emptyAccount('Chequing (12345-12-34567) $1,200.25', bankDateRange(60, now))
    expect(empty.id).toBe(parseOfx(ofx()).id)
    expect(empty.balance).toBe('1200.25')
    expect(empty.transactions).toEqual([])
    expect(
      emptyAccount('Visa (1234 5678 9012 3456) −$487.34', bankDateRange(60, now)).balance,
    ).toBe('-487.34')
    expect(() => emptyAccount('Unrecognized balance', bankDateRange(60, now))).toThrow()
  })
  it('fills long downtime with bounded overlapping exports instead of omitting a history gap', () => {
    const since = Date.parse('2026-04-01T00:00:00Z') / 1000
    const ranges = downloadRanges(60, since, now)
    expect(ranges.length).toBeGreaterThan(3)
    expect(ranges[0]?.start).toBeLessThan(since)
    expect(ranges.at(-1)?.to).toBe('2026-10-16')
    for (const [i, range] of ranges.entries()) {
      expect(range.end - range.start).toBeLessThanOrEqual(61 * 86400)
      if (i > 0) expect(range.start).toBeLessThanOrEqual(ranges[i - 1]?.end ?? 0)
    }
  })
})
