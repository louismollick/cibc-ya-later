import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CibcRefusedSignIn, CredentialsRejected, HistoryGap, UserError } from '../src/main/errors'
import { Store } from '../src/main/store'
import { SyncService } from '../src/main/sync'
import { sampleAccount } from './helpers'

afterEach(() => vi.useRealTimers())
describe('Refresh coordination', () => {
  it('cancels a queued refresh before the browser starts', async () => {
    const store = new Store(':memory:')
    const downloader = {
      download: vi.fn(async () => [sampleAccount()]),
      cancel: vi.fn(async () => {}),
      backfill: vi.fn(async () => []),
    }
    const sync = new SyncService(store, downloader, () => {})
    const job = sync.refresh()
    await sync.cancel()
    await job
    expect(downloader.download).not.toHaveBeenCalled()
    expect(store.lastSuccess()).toBeNull()
    store.close()
  })
  it('coalesces concurrent syncs and commits the completed download', async () => {
    const store = new Store(':memory:')
    let finish: (accounts: ReturnType<typeof sampleAccount>[]) => void = () => {}
    const downloader = {
      download: vi.fn(
        () =>
          new Promise<ReturnType<typeof sampleAccount>[]>((resolve) => {
            finish = resolve
          }),
      ),
      cancel: vi.fn(async () => {}),
      backfill: vi.fn(async () => []),
    }
    const sync = new SyncService(store, downloader, () => {})
    const first = sync.refresh()
    expect(sync.refresh()).toBe(first)
    await Promise.resolve()
    expect(downloader.download).toHaveBeenCalledTimes(1)
    expect(store.lastSuccess()).toBeNull()
    finish([sampleAccount()])
    await first
    expect(store.lastSuccess()).not.toBeNull()
    store.close()
  })
  it('preserves the cache after failures and allows another sync immediately', async () => {
    const store = new Store(':memory:')
    store.saveSnapshot([sampleAccount()], 1, 1792108800)
    const downloader = {
      download: vi.fn(async () => {
        throw new Error('sensitive third party detail')
      }),
      cancel: vi.fn(async () => {}),
      backfill: vi.fn(async () => []),
    }
    const sync = new SyncService(store, downloader, () => {})
    await sync.refresh()
    expect(downloader.download).toHaveBeenCalledTimes(1)
    expect(store.lastSuccess()).toBe(1792108800)
    expect(sync.status.message).toBe('Sync failed.')
    await sync.refresh()
    expect(downloader.download).toHaveBeenCalledTimes(2)
    store.close()
  })
})
it('never publishes a snapshot after cancellation during final downloader cleanup', async () => {
  const store = new Store(':memory:')
  let finish: (accounts: ReturnType<typeof sampleAccount>[]) => void = () => {}
  const downloader = {
    download: vi.fn(
      () =>
        new Promise<ReturnType<typeof sampleAccount>[]>((resolve) => {
          finish = resolve
        }),
    ),
    cancel: vi.fn(async () => {}),
    backfill: vi.fn(async () => []),
  }
  const sync = new SyncService(store, downloader, () => {})
  const work = sync.refresh()
  await vi.waitFor(() => expect(downloader.download).toHaveBeenCalled())
  await sync.cancel()
  finish([sampleAccount()])
  await work
  expect(store.lastSuccess()).toBeNull()
  expect(sync.status.phase).toBe('idle')
  store.close()
})

describe('Refused sign-in retry', () => {
  it.each(['success', 'refused', 'cancel', 'stop'] as const)(
    'handles %s after the first refusal',
    async (outcome) => {
      vi.useFakeTimers()
      const store = new Store(':memory:')
      const download = vi.fn(async () => [sampleAccount()])
      download.mockRejectedValueOnce(new CibcRefusedSignIn())
      if (outcome === 'refused') download.mockRejectedValueOnce(new CibcRefusedSignIn())
      const sync = new SyncService(
        store,
        {
          download,
          cancel: vi.fn(async () => {}),
          backfill: vi.fn(async () => []),
        },
        () => {},
      )
      const work = sync.refresh()
      await vi.advanceTimersByTimeAsync(0)
      expect(sync.status.message).toBe('Retrying sign-in')
      await vi.advanceTimersByTimeAsync(59_999)
      expect(download).toHaveBeenCalledTimes(1)
      if (outcome === 'cancel' || outcome === 'stop') {
        await sync[outcome]()
        await work
        expect(sync.status.phase).toBe('idle')
        expect(vi.getTimerCount()).toBe(0)
        await vi.advanceTimersByTimeAsync(60_000)
        expect(download).toHaveBeenCalledTimes(1)
        expect(store.lastSuccess()).toBeNull()
      } else {
        await vi.advanceTimersByTimeAsync(1)
        await work
        await vi.advanceTimersByTimeAsync(60_000)
        expect(download).toHaveBeenCalledTimes(2)
        expect(sync.status.phase).toBe(outcome === 'success' ? 'idle' : 'error')
        if (outcome === 'success') expect(store.lastSuccess()).not.toBeNull()
        else {
          expect(store.lastSuccess()).toBeNull()
          expect(sync.status.message).toBe('CIBC refused the sign-in. Try again later.')
        }
      }
      store.close()
    },
  )
})

it('does not retry rejected credentials and suppresses scheduled sign-in attempts', async () => {
  vi.useFakeTimers()
  const store = new Store(':memory:')
  const download = vi.fn(async () => {
    throw new CredentialsRejected()
  })
  const sync = new SyncService(
    store,
    { download, backfill: download, cancel: vi.fn(async () => {}) },
    () => {},
  )
  await sync.refresh()
  await vi.advanceTimersByTimeAsync(60_000)
  sync.tick()
  await sync.refresh()
  await sync.startFullHistory()
  expect(download).toHaveBeenCalledTimes(1)
  expect(sync.credentialsRejected).toBe(true)
  expect(sync.status.message).toBe('CIBC rejected the password.')
  store.close()
})
it.each(['missing', 'gap'] as const)(
  'maps %s to a blocker and clears it on a successful sync',
  async (kind) => {
    const store = new Store(':memory:')
    store.saveSnapshot([sampleAccount(), sampleAccount('b')], 2)
    const rows =
      kind === 'missing'
        ? [sampleAccount()]
        : [
            {
              ...sampleAccount(),
              coverageStart: 1792368000,
              coverageEnd: 1792972800,
              transactions: [],
            },
            sampleAccount('b'),
          ]
    const download = vi.fn(async () => rows)
    const sync = new SyncService(
      store,
      { download, backfill: download, cancel: vi.fn(async () => {}) },
      () => {},
    )
    await sync.refresh()
    expect(sync.blocker).toEqual(
      kind === 'missing'
        ? { kind: 'missing-account', accountId: 'b', name: 'Chequing' }
        : { kind: 'history-gap' },
    )
    expect(sync.status.message).toBe(
      kind === 'missing' ? 'Chequing is no longer at CIBC.' : 'History has a gap.',
    )
    if (kind === 'missing') {
      sync.clearMissingAccount('other')
      expect(sync.blocker).not.toBeNull()
      store.closeAccount('b')
      sync.clearMissingAccount('b')
      expect(sync.blocker).toBeNull()
    }
    download.mockResolvedValue([sampleAccount(), sampleAccount('b')])
    await sync.startFullHistory()
    expect(sync.blocker).toBeNull()
    store.close()
  },
)

it('keeps rejected credentials blocked across database reopen until explicitly cleared', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'cibc-rejection-'))
  const path = join(directory, 'test.sqlite')
  let store = new Store(path)
  const download = vi.fn(async () => {
    throw new CredentialsRejected()
  })
  const downloader = { download, backfill: download, cancel: vi.fn(async () => {}) }
  try {
    await new SyncService(store, downloader, () => {}).refresh()
    store.close()
    store = new Store(path)
    const sync = new SyncService(store, downloader, () => {})
    expect(sync.credentialsRejected).toBe(true)
    sync.tick()
    await sync.refresh()
    await sync.startFullHistory()
    expect(download).toHaveBeenCalledTimes(1)
    sync.credentialsRejected = false
    expect(store.get('credentialsRejected')).toBe('false')
    await sync.refresh()
    expect(download).toHaveBeenCalledTimes(2)
  } finally {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

it('blocks all sync entry points when credentials are unavailable or changing', async () => {
  const store = new Store(':memory:')
  const download = vi.fn(async () => [sampleAccount()])
  let eligible = false
  const sync = new SyncService(
    store,
    { download, backfill: download, cancel: vi.fn(async () => {}) },
    () => {},
    () => eligible,
  )
  sync.tick()
  await sync.refresh()
  await sync.startFullHistory()
  expect(download).not.toHaveBeenCalled()
  expect(store.get('scheduleCursor')).toBeUndefined()
  eligible = true
  await sync.refresh()
  expect(download).toHaveBeenCalledTimes(1)
  store.close()
})

it.each([
  'CIBC requires an unsupported verification challenge.',
  'CIBC browser is missing. Reinstall the app.',
  'Verification code expired. Sync again.',
])('shows app-authored instructions: %s', async (message) => {
  const store = new Store(':memory:')
  const download = vi.fn(async () => {
    throw new UserError(message)
  })
  const sync = new SyncService(
    store,
    { download, backfill: download, cancel: vi.fn(async () => {}) },
    () => {},
  )
  await sync.refresh()
  expect(sync.status.message).toBe(message)
  expect(sync.status.phase).toBe('error')
  store.close()
})

it.each(['refresh', 'startFullHistory'] as const)(
  'clears an earlier blocker on %s before a different failure',
  async (entry) => {
    const store = new Store(':memory:')
    const download = vi.fn(async () => {
      throw new UserError('Verification code expired.')
    })
    download.mockRejectedValueOnce(new HistoryGap())
    const sync = new SyncService(
      store,
      { download, backfill: download, cancel: vi.fn(async () => {}) },
      () => {},
    )
    await sync.refresh()
    expect(sync.blocker).toEqual({ kind: 'history-gap' })
    const work = sync[entry]()
    expect(sync.blocker).toBeNull()
    await work
    expect(sync.blocker).toBeNull()
    expect(sync.status.message).toBe('Verification code expired.')
    store.close()
  },
)
