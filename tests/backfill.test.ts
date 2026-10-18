import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { CibcRefusedSignIn } from '../src/main/errors'
import { Store } from '../src/main/store'
import { SyncService } from '../src/main/sync'
import { sampleAccount } from './helpers'

const historical = () => ({
  ...sampleAccount(),
  coverageStart: 1577836800,
  transactions: [
    { id: 'old', posted: 1577923200, amount: '-1.25', description: 'Old payment', pending: false },
    ...sampleAccount().transactions,
  ],
})
it('persists full history completion and rows atomically across reopening', () => {
  const root = mkdtempSync(join(tmpdir(), 'full-history-'))
  let store = new Store(join(root, 'db'))
  try {
    store.saveSnapshot([sampleAccount()], 1, 1792300000)
    store.saveSnapshot([historical()], 1, 1792400000, true)
    store.close()
    store = new Store(join(root, 'db'))
    expect(store.fullHistoryCompletedAt()).toBe(1792400000)
    expect(store.coverage()[0]?.coverageStart).toBe(1577836800)
    store.saveSnapshot([sampleAccount()], 1, 1792500000)
    expect(
      store.accountSet('', { accounts: [], pending: true, balancesOnly: false })[0]?.transactions,
    ).toHaveLength(4)
    expect(store.fullHistoryCompletedAt()).toBe(1792400000)
  } finally {
    store.close()
    rmSync(root, { recursive: true, force: true })
  }
})
it('rolls back full history completion with a failed snapshot', () => {
  const store = new Store(':memory:')
  store.saveSnapshot([sampleAccount()], 1, 1792300000)
  const bad = historical()
  const transaction = bad.transactions[1]
  if (transaction) transaction.amount = '-999.00'
  expect(() => store.saveSnapshot([bad], 1, 1792400000, true)).toThrow('changed an imported')
  expect(store.fullHistoryCompletedAt()).toBeNull()
  expect(store.lastSuccess()).toBe(1792300000)
  store.close()
})
it.each([1792300000, null])('migrates old complete jobs with lastSuccess %s', (lastSuccess) => {
  const store = new Store(':memory:')
  store.set('backfill', JSON.stringify({ status: 'complete', message: 'Done' }))
  if (lastSuccess !== null) store.set('lastSuccess', String(lastSuccess))
  expect(store.fullHistoryCompletedAt()).toBe(lastSuccess ?? Math.floor(Date.now() / 1000))
  store.set('backfill', '{}')
  expect(store.fullHistoryCompletedAt()).not.toBeNull()
  store.close()
})
it.each(['success', 'failure', 'cancel'] as const)(
  'handles full history %s without paused state',
  async (outcome) => {
    const store = new Store(':memory:')
    let finish: (rows: ReturnType<typeof historical>[]) => void = () => {}
    const downloader = {
      download: vi.fn(async () => [sampleAccount()]),
      backfill: vi.fn(
        () =>
          new Promise<ReturnType<typeof historical>[]>((resolve, reject) => {
            finish = resolve
            if (outcome === 'failure') reject(Error('private'))
          }),
      ),
      cancel: vi.fn(async () => {}),
    }
    const sync = new SyncService(store, downloader, () => {})
    const work = sync.startFullHistory()
    expect(sync.fullHistoryRunning).toBe(true)
    expect(sync.refresh()).toBe(work)
    expect(() => sync.startFullHistory()).toThrow('active download')
    await Promise.resolve()
    if (outcome === 'cancel') await sync.cancel()
    finish([historical()])
    await work
    expect(sync.fullHistoryRunning).toBe(false)
    expect(store.fullHistoryCompletedAt() !== null).toBe(outcome === 'success')
    expect(sync.status.phase).toBe(outcome === 'failure' ? 'error' : 'idle')
    if (outcome === 'failure') expect(sync.status.message).toBe('Sync failed.')
    store.close()
  },
)

it('does not retry a refused full history sign-in', async () => {
  vi.useFakeTimers()
  const store = new Store(':memory:')
  try {
    const backfill = vi.fn(async () => {
      throw new CibcRefusedSignIn()
    })
    const sync = new SyncService(
      store,
      { backfill, download: vi.fn(async () => []), cancel: vi.fn(async () => {}) },
      () => {},
    )
    await sync.startFullHistory()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(backfill).toHaveBeenCalledTimes(1)
    expect(store.fullHistoryCompletedAt()).toBeNull()
    expect(sync.status.message).toBe('CIBC refused the sign-in. Try again later.')
  } finally {
    store.close()
    vi.useRealTimers()
  }
})
