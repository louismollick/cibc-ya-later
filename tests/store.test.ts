import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { HistoryGap, MissingAccount } from '../src/main/errors'
import { defaults, Store } from '../src/main/store'
import { sampleAccount } from './helpers'

const stores: Store[] = []
const create = () => {
  const store = new Store(':memory:')
  stores.push(store)
  return store
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})
describe('Verified cache', () => {
  it('commits all accounts together and deduplicates overlapping downloads', () => {
    const store = create(),
      accounts = [sampleAccount(), sampleAccount('account-b')]
    store.saveSnapshot(accounts, 2)
    store.saveSnapshot(accounts, 2)
    expect(
      store
        .accountSet('', { accounts: [], pending: true, balancesOnly: false })
        .map((a) => a.transactions?.length),
    ).toEqual([3, 3])
  })
  it('rolls back balances and every account if a later account loses a transaction', () => {
    const store = create(),
      accounts = [sampleAccount(), sampleAccount('account-b')]
    store.saveSnapshot(accounts, 2, 1792200000)
    const changed = structuredClone(accounts)
    if (changed[0]) changed[0].balance = '99.00'
    changed[1]?.transactions.pop()
    expect(() => store.saveSnapshot(changed, 2, 1792200300)).toThrow('omitted')
    expect(store.accountSummary()[0]?.balance).toBe('1200.25')
    expect(store.lastSuccess()).toBe(1792200000)
  })
  it('rejects a missing account and preserves older history', () => {
    const store = create(),
      accounts = [sampleAccount(), sampleAccount('account-b')]
    store.saveSnapshot(accounts, 2)
    expect(() => store.saveSnapshot([sampleAccount()], 1)).toThrow(MissingAccount)
    for (const a of accounts) {
      a.coverageStart = 1792108800
      a.transactions = []
    }
    store.saveSnapshot(accounts, 2)
    expect(
      store.accountSet('', { accounts: [], pending: true, balancesOnly: false })[0]?.transactions
        ?.length,
    ).toBe(3)
  })
  it('filters start inclusive, end exclusive, account, pending, and balances only', () => {
    const store = create()
    store.saveSnapshot([sampleAccount(), sampleAccount('b')], 2)
    const result = store.accountSet('https://bank.tailnet.ts.net/simplefin', {
      start: 1791763200,
      end: 1791849600,
      accounts: ['account-a'],
      pending: false,
      balancesOnly: false,
    })
    expect(result).toHaveLength(1)
    expect(result[0]?.transactions?.map((t) => t.id)).toEqual(['account-a-one'])
    expect(
      store.accountSet('https://bank.tailnet.ts.net/simplefin', {
        accounts: [],
        pending: false,
        balancesOnly: false,
      })[0]?.transactions,
    ).toHaveLength(2)
    expect(
      store.accountSet('https://bank.tailnet.ts.net/simplefin', {
        accounts: [],
        pending: true,
        balancesOnly: false,
      })[0]?.transactions,
    ).toHaveLength(3)
    expect(
      store.accountSet('https://bank.tailnet.ts.net/simplefin', {
        accounts: [],
        pending: false,
        balancesOnly: true,
      })[0],
    ).not.toHaveProperty('transactions')
  })
  it('issues separate one-time expiring credentials and supports revocation', () => {
    const store = create(),
      base = 'https://bank.tailnet.ts.net/simplefin'
    const token = store.createToken('Actual', base, 100)
    const url = new URL(Buffer.from(token, 'base64').toString())
    const raw = url.pathname.split('/').at(-1) ?? ''
    const access = store.claim(raw, base, 101)
    expect(access).toBeTruthy()
    expect(store.claim(raw, base, 102)).toBeNull()
    const credentials = new URL(access ?? '')
    expect(store.authenticate(credentials.username, credentials.password)).toBe(true)
    expect(store.authenticate(credentials.username, 'wrong')).toBe(false)
    expect(store.authenticate('unknown', credentials.password)).toBe(false)
    store.revokeClient(credentials.username)
    expect(store.authenticate(credentials.username, credentials.password)).toBe(false)
    const expired =
      new URL(Buffer.from(store.createToken('Sure', base, 100), 'base64').toString()).pathname
        .split('/')
        .at(-1) ?? ''
    expect(store.claim(expired, base, 1000)).toBeNull()
  })
})
it('rejects disjoint history coverage and allows closed accounts to disappear', () => {
  const store = create(),
    first = sampleAccount(),
    second = sampleAccount('second')
  store.saveSnapshot([first, second], 2)
  const gap = { ...first, coverageStart: 1792368000, coverageEnd: 1792972800, transactions: [] }
  expect(() => store.saveSnapshot([gap, second], 2)).toThrow(HistoryGap)
  store.closeAccount('second')
  store.saveSnapshot([first], 1)
  expect(store.accountSummary().find((a) => a.id === 'second')).toBeUndefined()
  expect(
    store.accountSet('https://bank.tailnet.ts.net/simplefin', {
      accounts: [],
      pending: false,
      balancesOnly: false,
    }),
  ).toHaveLength(1)
  store.saveSnapshot([first, second], 2)
  expect(store.closedAccounts()).toEqual([])
  expect(() => store.saveSnapshot([first], 1)).toThrow(MissingAccount)
})

it('loads an old settings blob and strips removed fields, including disabled schedule', () => {
  const store = create()
  store.set(
    'settings',
    JSON.stringify({
      baseUrl: 'https://old.example/simplefin',
      lookbackDays: 30,
      headless: false,
      staleMinutes: 360,
      schedule: { enabled: false, catchUp: false, weekdays: [2, 5], time: '10:00' },
      launchAtLogin: true,
    }),
  )
  expect(store.settings()).toEqual({
    schedule: { weekdays: [2, 5], time: '10:00' },
    launchAtLogin: true,
  })
})
it.each(['{corrupt', '{"schedule":{"weekdays":[],"time":"invalid"}}'])(
  'defaults invalid saved settings: %s',
  (value) => {
    const store = create()
    store.set('settings', value)
    expect(store.settings()).toEqual(defaults)
  },
)
it('stores only account last4 and excludes closed accounts from summaries', () => {
  const store = create()
  store.saveSnapshot([{ ...sampleAccount(), sourceId: '12345-12-34567' }], 1)
  expect(store.accountSummary()[0]?.last4).toBe('4567')
  store.closeAccount('account-a')
  expect(store.accountSummary()).toEqual([])
})

it('migrates old account rows with an empty last4 until their next download', () => {
  const root = mkdtempSync(join(tmpdir(), 'old-accounts-'))
  let store = new Store(join(root, 'db'))
  try {
    const account = { ...sampleAccount(), sourceId: '12345-12-34567' }
    store.saveSnapshot([account], 1)
    store.sqlite.exec('ALTER TABLE accounts DROP COLUMN last4')
    store.close()
    store = new Store(join(root, 'db'))
    expect(store.accountSummary()[0]?.last4).toBe('')
    store.saveSnapshot([account], 1)
    expect(store.accountSummary()[0]?.last4).toBe('4567')
  } finally {
    store.close()
    rmSync(root, { recursive: true, force: true })
  }
})
