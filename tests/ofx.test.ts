import { describe, expect, it } from 'vitest'
import { money, ofxDate, parseOfx } from '../src/main/ofx'
import { ofx } from './helpers'

describe('CIBC OFX exports', () => {
  it('parses SGML deposit exports, exact money and bank issued IDs', () => {
    const result = parseOfx(ofx())
    expect(result.transactions).toHaveLength(2)
    expect(result.transactions[0]).toMatchObject({
      amount: '-12.34',
      description: 'GROCERY & MORE Purchase',
      pending: false,
    })
    expect(parseOfx(ofx()).transactions.map((t) => t.id)).toEqual(
      result.transactions.map((t) => t.id),
    )
    expect(result.id).not.toContain('12345')
  })
  it('preserves credit card liability sign and accepts verified empty exports', () => {
    expect(parseOfx(ofx({ credit: true })).balance).toBe('-1200.25')
    expect(parseOfx(ofx({ transactions: false })).transactions).toEqual([])
  })
  it('rejects truncation, error statuses, missing IDs and duplicates', () => {
    for (const text of [
      ofx().toString().replace('</OFX>', ''),
      ofx().toString().replace('<CODE>0', '<CODE>2000'),
      ofx().toString().replace('<FITID>abc-123', '<FITID>'),
      ofx().toString().replace('abc-124', 'abc-123'),
    ])
      expect(() => parseOfx(Buffer.from(text))).toThrow()
  })
  it('does not round currency through floating point', () => {
    expect(money('999999999999999.99')).toBe('999999999999999.99')
    expect(money('-0')).toBe('0.00')
    expect(() => money('1.999')).toThrow()
  })
  it('handles OFX offsets and invalid dates', () => {
    expect(ofxDate('20261016120000[-4:EDT]')).toBe(Date.parse('2026-10-16T16:00:00Z') / 1000)
    expect(() => ofxDate('20260230120000')).toThrow()
  })
})
it('converts CIBC card debt and overpayment signs without changing transaction amounts', () => {
  const debt = parseOfx(ofx({ credit: true }))
  expect(debt.balance).toBe('-1200.25')
  expect(debt.transactions[0]?.amount).toBe('-12.34')
  const overpaid = parseOfx(
    Buffer.from(ofx({ credit: true }).toString().replace('<BALAMT>1200.25', '<BALAMT>-75.00')),
  )
  expect(overpaid.balance).toBe('75.00')
})
