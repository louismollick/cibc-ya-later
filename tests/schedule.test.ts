import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { scheduleWindow } from '../src/main/schedule'
import { Store } from '../src/main/store'
import { SyncService } from '../src/main/sync'
import { sampleAccount } from './helpers'

process.env.TZ = 'America/Winnipeg'
let store: Store
beforeEach(() => {
  store = new Store(':memory:')
  vi.useFakeTimers()
})
afterEach(() => {
  store.close()
  vi.useRealTimers()
})
function service() {
  store.set(
    'settings',
    JSON.stringify({
      ...store.settings(),
      schedule: { weekdays: [1, 2, 3, 4, 5], time: '18:00' },
    }),
  )
  const downloader = {
    download: vi.fn(async () => [sampleAccount()]),
    cancel: vi.fn(async () => {}),
    backfill: vi.fn(async () => []),
  }
  return { sync: new SyncService(store, downloader, () => {}), downloader }
}
const flush = () => vi.advanceTimersByTimeAsync(0)
describe('Weekly schedule and missed runs', () => {
  it('supports Tuesday and Friday at 10am', () => {
    const result = scheduleWindow(
      { weekdays: [2, 5], time: '10:00' },
      new Date('2026-10-14T19:00:00-05:00'),
    )
    expect(result.previous).toBe(Date.parse('2026-10-13T10:00:00-05:00') / 1000)
    expect(result.next).toBe(Date.parse('2026-10-16T10:00:00-05:00') / 1000)
  })
  it('catches up once on wake at 9pm and does not replay missed days after restart', async () => {
    const { sync, downloader } = service()
    vi.setSystemTime(new Date('2026-10-14T21:00:00-05:00'))
    sync.tick()
    await flush()
    expect(downloader.download).toHaveBeenCalledTimes(1)
    sync.tick()
    await flush()
    expect(downloader.download).toHaveBeenCalledTimes(1)
    const restarted = new SyncService(store, downloader, () => {})
    restarted.tick()
    await flush()
    expect(downloader.download).toHaveBeenCalledTimes(1)
  })
  it('does not repeat a scheduled failure on every timer tick', async () => {
    const { sync, downloader } = service()
    downloader.download.mockRejectedValue(new Error('bank failure'))
    vi.setSystemTime(new Date('2026-10-14T21:00:00-05:00'))
    sync.tick()
    await flush()
    sync.tick()
    await flush()
    expect(downloader.download).toHaveBeenCalledTimes(1)
  })
})
