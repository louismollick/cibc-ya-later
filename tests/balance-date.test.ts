import { expect, it } from 'vitest'
import { cibcBalanceDate } from '../src/main/ofx'

it('corrects CIBC balance timestamps using Toronto DST and respects explicit OFX offsets', () => {
  expect(cibcBalanceDate('20261016025039')).toBe(Date.parse('2026-10-16T06:50:39Z') / 1000)
  expect(cibcBalanceDate('20260201120000')).toBe(Date.parse('2026-02-01T17:00:00Z') / 1000)
  expect(cibcBalanceDate('20261016120000[-4:EDT]')).toBe(Date.parse('2026-10-16T16:00:00Z') / 1000)
})
