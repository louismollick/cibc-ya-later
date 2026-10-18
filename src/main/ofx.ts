import { createHash } from 'node:crypto'
import type { Transaction } from '../shared/types'
import { UserError } from './errors'

export function accountId(sourceId: string) {
  return `cibc-${digest(sourceId.replace(/\D/g, '')).slice(0, 32)}`
}

export const digest = (value: string) => createHash('sha256').update(value).digest('hex')

function value(text: string, tag: string): string | undefined {
  return new RegExp(`<${tag}>([^<\\r\\n]*)`, 'i').exec(text)?.[1]?.trim()
}
function required(text: string, tag: string): string {
  const found = value(text, tag)
  if (!found) throw new UserError(`CIBC export is missing ${tag}. Cache was not changed.`)
  return found
}
function block(text: string, tag: string): string {
  const found = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i').exec(text)?.[1]
  if (found === undefined) throw new UserError(`CIBC export is missing ${tag}.`)
  return found
}
export function money(input: string): string {
  if (!/^[+-]?\d+(?:\.\d{1,2})?$/.test(input))
    throw new UserError('Invalid monetary value in export.')
  const negative = input.startsWith('-')
  const [whole = '0', fraction = ''] = input.replace(/^[+-]/, '').split('.')
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'))
  return `${negative && cents !== 0n ? '-' : ''}${cents / 100n}.${(cents % 100n).toString().padStart(2, '0')}`
}

// OFX dates without an offset are GMT by the OFX specification. Keep date-only
// transaction timestamps at the bank's exported time, independent of Mac timezone.
export function ofxDate(input: string): number {
  const match =
    /^(\d{4})(\d{2})(\d{2})(?:(\d{2})(\d{2})(\d{2}))?(?:\.\d+)?(?:\[([+-]?\d+(?:\.\d+)?)(?::[^\]]+)?\])?$/.exec(
      input,
    )
  if (!match) throw new UserError('Invalid date in CIBC export.')
  const [, y, m, d, h = '00', min = '00', s = '00', offset = '0'] = match
  const time = Date.UTC(Number(y), Number(m) - 1, Number(d), Number(h), Number(min), Number(s))
  const date = new Date(time)
  if (
    date.getUTCFullYear() !== Number(y) ||
    date.getUTCMonth() !== Number(m) - 1 ||
    date.getUTCDate() !== Number(d) ||
    Number(h) > 23 ||
    Number(min) > 59 ||
    Number(s) > 59 ||
    Math.abs(Number(offset)) > 14
  )
    throw new UserError('Invalid date in CIBC export.')
  return Math.floor(time / 1000 - Number(offset) * 3600)
}
function decode(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .trim()
}
export function parseOfx(buffer: Buffer) {
  if (buffer.length > 20 * 1024 * 1024) throw new UserError('CIBC export exceeds size limit.')
  const header = buffer.subarray(0, 250).toString('ascii')
  const text = new TextDecoder(/CHARSET:1252/i.test(header) ? 'windows-1252' : 'utf-8', {
    fatal: true,
  }).decode(buffer)
  if (!/<OFX>/i.test(text) || !/<\/OFX>\s*$/i.test(text))
    throw new UserError('Incomplete or invalid OFX download.')
  for (const status of text.matchAll(/<STATUS>([\s\S]*?)<\/STATUS>/gi)) {
    if (required(status[1] ?? '', 'CODE') !== '0')
      throw new UserError('CIBC returned an unsuccessful export status.')
  }
  const statements = [...text.matchAll(/<(STMTRS|CCSTMTRS)>([\s\S]*?)<\/\1>/gi)]
  if (statements.length !== 1) throw new UserError('Expected exactly one account in CIBC export.')
  const statement = statements[0]?.[2] ?? ''
  const sourceId = required(statement, 'ACCTID').replace(/\s/g, '')
  const id = accountId(sourceId)
  const currency = required(statement, 'CURDEF')
  if (!/^[A-Z]{3}$/.test(currency)) throw new UserError('Invalid export currency.')
  const ledger = block(statement, 'LEDGERBAL')
  const rawBalance = money(required(ledger, 'BALAMT'))
  // CIBC exports a credit card debt as positive BALAMT, unlike its account
  // selector and SimpleFIN. Purchases already have negative transaction amounts.
  const balance = statements[0]?.[1]?.toUpperCase() === 'CCSTMTRS' ? negate(rawBalance) : rawBalance
  const balanceDate = cibcBalanceDate(required(ledger, 'DTASOF'))
  const list = block(statement, 'BANKTRANLIST')
  const transactions: Transaction[] = []
  const ids = new Set<string>()
  for (const match of list.matchAll(/<STMTTRN>([\s\S]*?)<\/STMTTRN>/gi)) {
    const item = match[1] ?? ''
    // FITID is supplied by CIBC and survives overlapping downloads. Never invent
    // a row-index ID, which would duplicate imports as the rolling window moves.
    const transactionId = `txn-${digest(`${id}:${required(item, 'FITID')}`)}`
    if (ids.has(transactionId)) throw new UserError('Duplicate transaction ID in CIBC export.')
    ids.add(transactionId)
    if (value(item, 'CORRECTFITID'))
      throw new UserError('CIBC issued a transaction correction; review required.')
    const description = [value(item, 'NAME'), value(item, 'MEMO')]
      .filter(Boolean)
      .map((t) => decode(t ?? ''))
      .join(' ')
      .trim()
    if (!description) throw new UserError('Export transaction has no description.')
    transactions.push({
      id: transactionId,
      posted: ofxDate(required(item, 'DTPOSTED')),
      amount: money(required(item, 'TRNAMT')),
      description,
      pending: false,
    })
  }
  if ((list.match(/<STMTTRN>/gi)?.length ?? 0) !== transactions.length)
    throw new UserError('Truncated transaction list.')
  return {
    id,
    sourceId,
    currency,
    balance,
    balanceDate,
    transactions,
    exportStart: ofxDate(required(list, 'DTSTART')),
    exportEnd: ofxDate(required(list, 'DTEND')),
  }
}

function negate(amount: string) {
  return amount === '0.00' ? amount : amount.startsWith('-') ? amount.slice(1) : `-${amount}`
}
// Live CIBC files use Toronto wall time for DTASOF without an OFX offset.
// Transaction dates remain as exported, at noon, so their posting day is stable.
export function cibcBalanceDate(input: string) {
  const timestamp = ofxDate(input)
  if (input.includes('[')) return timestamp
  const offset = new Intl.DateTimeFormat('en', {
    timeZone: 'America/Toronto',
    timeZoneName: 'longOffset',
  })
    .formatToParts(new Date(timestamp * 1000))
    .find((p) => p.type === 'timeZoneName')?.value
  const match = /GMT([+-])(\d{2}):(\d{2})/.exec(offset ?? '')
  if (!match) throw new UserError('Could not determine the CIBC balance timezone.')
  return timestamp - (match[1] === '-' ? -1 : 1) * (Number(match[2]) * 3600 + Number(match[3]) * 60)
}
