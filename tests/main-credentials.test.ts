import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { sampleAccount } from './helpers'

const mock = vi.hoisted(() => ({
  rejectedOnStartup: false,
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  download: vi.fn(),
  backfill: vi.fn(),
  save: vi.fn(),
  clear: vi.fn(),
  trayMenu: [] as { label?: string; click?: () => void }[],
  stores: [] as { close: () => void; set: (key: string, value: string) => void }[],
  contents: {
    send: vi.fn(),
    mainFrame: { url: 'http://localhost:5173/' },
    setWindowOpenHandler: vi.fn(),
    on: vi.fn(),
    session: { setPermissionRequestHandler: vi.fn() },
  },
}))
vi.mock('electron', () => ({
  app: {
    setName: vi.fn(),
    getPath: () => '/tmp/cibc-main-test',
    setPath: vi.fn(),
    requestSingleInstanceLock: () => true,
    on: vi.fn(),
    whenReady: async () => {},
    isPackaged: false,
    getAppPath: () => '/tmp',
    getLoginItemSettings: () => ({}),
    setLoginItemSettings: vi.fn(),
  },
  BrowserWindow: class {
    webContents = mock.contents
    on = vi.fn()
    once = vi.fn()
    loadURL = vi.fn()
  },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      mock.handlers.set(channel, handler),
  },
  Menu: { buildFromTemplate: (items: unknown[]) => items, setApplicationMenu: vi.fn() },
  Tray: class {
    on = vi.fn()
    setToolTip = vi.fn()
    setContextMenu(items: typeof mock.trayMenu) {
      mock.trayMenu = items
    }
  },
  nativeImage: { createFromPath: () => ({ resize: () => ({ setTemplateImage: vi.fn() }) }) },
  powerMonitor: { on: vi.fn() },
  powerSaveBlocker: { start: () => 1, stop: vi.fn() },
  clipboard: {},
  dialog: {},
  shell: {},
  Notification: class {
    show = vi.fn()
  },
}))
vi.mock('node:fs', async (original) => ({
  ...(await original<typeof import('node:fs')>()),
  mkdirSync: vi.fn(),
  chmodSync: vi.fn(),
}))
vi.mock('../src/main/store', async (original) => {
  const module = await original<typeof import('../src/main/store')>()
  return {
    ...module,
    Store: class extends module.Store {
      constructor() {
        super(':memory:')
        if (mock.rejectedOnStartup) this.set('credentialsRejected', 'true')
        mock.stores.push(this)
      }
    },
  }
})
vi.mock('../src/main/vault', () => ({
  Vault: class {
    credentials = async () => ({ card: '1234567890123456', password: 'password' })
    saveCredentials = mock.save
    clear = mock.clear
  },
}))
vi.mock('../src/main/cibc', () => ({
  CibcDownloader: class {
    download = mock.download
    backfill = mock.backfill
    cancel = vi.fn(async () => {})
  },
}))
vi.mock('../src/main/server', () => ({
  simplefinServer: () => ({}),
  mfaServer: () => ({}),
  listen: async () => {},
}))
vi.mock('../src/main/tailscale', () => ({
  tailscaleStatus: async () => ({ running: true, serving: true, hostname: 'mac.example.ts.net' }),
  configureTailscale: async () => {},
}))

let invoke: (channel: string, ...args: unknown[]) => unknown
beforeEach(async () => {
  vi.resetModules()
  vi.useFakeTimers()
  vi.stubEnv('ELECTRON_RENDERER_URL', 'http://localhost:5173/')
  mock.rejectedOnStartup = false
  mock.handlers.clear()
  mock.download.mockReset().mockResolvedValue([sampleAccount()])
  mock.backfill.mockReset().mockResolvedValue([sampleAccount()])
  mock.save.mockReset().mockResolvedValue(undefined)
  mock.clear.mockReset().mockResolvedValue(undefined)
  await import('../src/main/index')
  await vi.waitFor(() => expect(mock.handlers.has('download-full-history')).toBe(true))
  // Use the trusted frame created by the mocked BrowserWindow.
  invoke = (channel, ...args) => {
    const handler = mock.handlers.get(channel)
    if (!handler) throw new Error(`Missing handler: ${channel}`)
    return handler({ sender: mock.contents, senderFrame: mock.contents.mainFrame }, ...args)
  }
})

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllEnvs()
  for (const store of mock.stores.splice(0)) store.close()
})

it.each(['sign-in', 'sign-out'] as const)(
  'blocks sync and credential changes while %s is awaiting Keychain',
  async (channel) => {
    let finish: () => void = () => {}
    const pending = new Promise<void>((resolve) => {
      finish = resolve
    })
    const operation = channel === 'sign-in' ? mock.save : mock.clear
    operation.mockReturnValueOnce(pending)
    const work = invoke(channel, '1234567890123456', 'password', false)
    invoke('sync')
    invoke('download-full-history')
    mock.trayMenu.find((item) => item.label === 'Sync Now')?.click?.()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(mock.download).not.toHaveBeenCalled()
    expect(mock.backfill).not.toHaveBeenCalled()
    await expect(invoke('sign-in', '1234567890123456', 'password', false)).rejects.toThrow(
      'credential change',
    )
    await expect(invoke('sign-out')).rejects.toThrow('credential change')
    finish()
    await work
    await vi.advanceTimersByTimeAsync(0)
    expect(mock.download).toHaveBeenCalledTimes(channel === 'sign-in' ? 1 : 0)
    expect(invoke('state')).toMatchObject({ credentials: channel === 'sign-in' ? 'saved' : 'none' })
    if (channel === 'sign-out') {
      invoke('sync')
      invoke('download-full-history')
      await vi.advanceTimersByTimeAsync(30_000)
      expect(mock.download).not.toHaveBeenCalled()
      expect(mock.backfill).not.toHaveBeenCalled()
    }
  },
)

it.each(['sign-in', 'sign-out'] as const)(
  'clears persisted rejection only after %s completes',
  async (channel) => {
    const { CredentialsRejected } = await import('../src/main/errors')
    mock.download.mockRejectedValueOnce(new CredentialsRejected())
    invoke('sync')
    await vi.advanceTimersByTimeAsync(0)
    expect(invoke('state')).toMatchObject({ credentials: 'rejected' })
    invoke('download-full-history')
    expect(mock.backfill).not.toHaveBeenCalled()
    let finish: () => void = () => {}
    const pending = new Promise<void>((resolve) => {
      finish = resolve
    })
    const operation = channel === 'sign-in' ? mock.save : mock.clear
    operation.mockReturnValueOnce(pending)
    const work = invoke(channel, '1234567890123456', 'password', false)
    expect(invoke('state')).toMatchObject({ credentials: 'rejected' })
    finish()
    await work
    await vi.advanceTimersByTimeAsync(0)
    expect(invoke('state')).toMatchObject({ credentials: channel === 'sign-in' ? 'saved' : 'none' })
  },
)

it('reports persisted rejection in AppState after startup and blocks schedule catch-up', async () => {
  vi.clearAllTimers()
  vi.resetModules()
  mock.handlers.clear()
  mock.rejectedOnStartup = true
  await import('../src/main/index')
  await vi.waitFor(() => expect(mock.handlers.has('download-full-history')).toBe(true))
  expect(invoke('state')).toMatchObject({ credentials: 'rejected' })
  invoke('sync')
  invoke('download-full-history')
  await vi.advanceTimersByTimeAsync(30_000)
  expect(mock.download).not.toHaveBeenCalled()
  expect(mock.backfill).not.toHaveBeenCalled()
})

it.each(['sign-in', 'sign-out'] as const)(
  'keeps rejection after a failed %s and releases the credential lock',
  async (channel) => {
    const store = mock.stores.at(-1)
    store?.set('credentialsRejected', 'true')
    const operation = channel === 'sign-in' ? mock.save : mock.clear
    operation.mockRejectedValueOnce(new Error('Keychain unavailable'))
    await expect(invoke(channel, '1234567890123456', 'password', false)).rejects.toThrow(
      'Keychain unavailable',
    )
    expect(invoke('state')).toMatchObject({ credentials: 'rejected' })
    await invoke('sign-out')
    expect(invoke('state')).toMatchObject({ credentials: 'none' })
  },
)
