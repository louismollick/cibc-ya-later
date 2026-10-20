import { chmodSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  Notification,
  nativeImage,
  powerMonitor,
  powerSaveBlocker,
  shell,
  Tray,
} from 'electron'
import { z } from 'zod'
import trayIcon from '../../resources/trayTemplate.png?asset'
import type { AppState } from '../shared/types'
import { CibcDownloader } from './cibc'
import { UserError } from './errors'
import { activityLog } from './log'
import { MfaGate } from './mfa'
import { listen, mfaServer, simplefinServer } from './server'
import { exportRelayShortcut } from './shortcut'
import { Store } from './store'
import { SyncService } from './sync'
import { configureTailscale, tailscaleStatus } from './tailscale'
import {
  codeSchema,
  credentialsSchema,
  labelSchema,
  settingsSchema,
  validBaseUrl,
} from './validation'
import { Vault } from './vault'

app.setName('CIBC Ya Later')
const dataPath = app.getPath('userData')
app.setPath('userData', dataPath)
let window: BrowserWindow | null = null
let tray: Tray | null = null
let quitting = false
let blocker: number | null = null
if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on('second-instance', () => showWindow())
  void app
    .whenReady()
    .then(start)
    .catch((error: unknown) => {
      console.error('CIBC Ya Later could not start', error)
      new Notification({
        title: 'CIBC Ya Later could not start',
        body: 'Check that macOS Keychain and the local database are available.',
      }).show()
      app.quit()
    })
}
function showWindow() {
  if (quitting || !window || window.isDestroyed()) return
  window.show()
  window.focus()
}
async function start() {
  if (process.platform !== 'darwin') throw new Error('CIBC Ya Later requires macOS.')
  mkdirSync(dataPath, { recursive: true, mode: 0o700 })
  chmodSync(dataPath, 0o700)
  const store = new Store(join(dataPath, 'cibc.sqlite'))
  const vault = new Vault(dataPath)
  const mfa = new MfaGate()
  const log = activityLog(join(dataPath, 'sync-log.txt'))
  let hasCredentials = Boolean(await vault.credentials())
  let changingCredentials = false
  let tailscale = await tailscaleStatus()
  let tailscaleError: string | null = null
  const updateTailscale = async () => {
    const status = await tailscaleStatus()
    if (quitting) return
    tailscale = status
    tailscaleError = tailscale.running ? null : 'Sign in to Tailscale on this Mac.'
    store.set('baseUrl', tailscale.hostname ? `https://${tailscale.hostname}/simplefin` : '')
    if (tailscale.running && !tailscale.serving) {
      try {
        await configureTailscale()
        tailscale = await tailscaleStatus()
      } catch {
        tailscaleError = 'Tailscale Serve could not be configured.'
      }
    }
  }
  await updateTailscale()
  const apiState = { running: false, error: null as string | null }
  let sync: SyncService
  const downloader = new CibcDownloader({
    browserRoot: app.isPackaged
      ? join(process.resourcesPath, 'browsers')
      : join(app.getAppPath(), 'node_modules/.cache/ms-playwright'),
    credentials: () => vault.credentials(),
    session: () => vault.session(),
    saveSession: (value) => vault.saveSession(value),
    mfa,
    diagnostics: join(dataPath, 'diagnostics'),
    log,
    status: (phase, message, codeExpiresAt) => {
      sync.update(phase, message, codeExpiresAt)
      if (phase === 'code-needed')
        new Notification({
          title: 'CIBC code needed',
          body: "Your iPhone didn't send it. Enter it in CIBC Ya Later.",
        }).show()
    },
  })
  // A rejected password must not be retried until the owner signs in again,
  // or repeated attempts could lock the CIBC account.
  const canSync = () => hasCredentials && !changingCredentials && !sync.credentialsRejected
  const change = () => {
    if (quitting) return
    window?.webContents.send('state-changed')
    if (sync?.busy && blocker === null) blocker = powerSaveBlocker.start('prevent-app-suspension')
    if (!sync?.busy && blocker !== null) {
      powerSaveBlocker.stop(blocker)
      blocker = null
    }
    const success = sync?.status.lastSuccess
    const date = success ? new Date(success * 1000) : null
    const synced = date
      ? `Synced ${
          date.toDateString() === new Date().toDateString()
            ? date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
            : date.toLocaleDateString([], { month: 'short', day: 'numeric' })
        }`
      : 'Not synced'
    const trayStatus = {
      idle: synced,
      'signing-in': 'Signing in',
      syncing: 'Syncing',
      'code-needed': 'Code needed',
      error: 'Sync failed',
    }[sync?.status.phase ?? 'idle']
    const syncItem = {
      label: 'Sync Now',
      accelerator: 'CommandOrControl+R',
      enabled: !sync?.busy && canSync(),
      click: () => {
        if (canSync()) void sync.refresh()
      },
    }
    tray?.setToolTip(`CIBC Ya Later: ${trayStatus}`)
    tray?.setContextMenu(
      Menu.buildFromTemplate([
        { label: trayStatus, enabled: false },
        syncItem,
        { label: 'Open CIBC Ya Later', click: showWindow },
        { type: 'separator' },
        { label: 'Quit', click: () => app.quit() },
      ]),
    )
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        { role: 'appMenu' },
        { label: 'File', submenu: [syncItem, { role: 'close' }] },
        { role: 'editMenu' },
        { role: 'windowMenu' },
      ]),
    )
  }
  sync = new SyncService(store, downloader, change, canSync)
  const api = simplefinServer(store, sync),
    mfaApi = mfaServer(mfa, () => store.get('baseUrl') ?? '', log)
  try {
    await listen(api, 3610)
    await listen(mfaApi, 3611)
    apiState.running = true
  } catch {
    api.close()
    mfaApi.close()
    apiState.error = 'Could not bind 127.0.0.1:3610 and 3611. Another app may be using these ports.'
  }
  const state = (): AppState => ({
    settings: store.settings(),
    sync: { ...sync.status },
    blocker: sync.blocker,
    credentials: !hasCredentials ? 'none' : sync.credentialsRejected ? 'rejected' : 'saved',
    cardLast4: store.get('cardLast4') || null,
    fullHistory: { completedAt: store.fullHistoryCompletedAt(), running: sync.fullHistoryRunning },
    accounts: store.accountSummary(),
    apps: store.clients(),
    simplefinUrl: tailscale.serving ? store.get('baseUrl') || null : null,
    tailscaleError,
    api: apiState,
  })
  window = new BrowserWindow({
    width: 760,
    height: 520,
    minWidth: 600,
    minHeight: 420,
    show: false,
    backgroundColor: '#000000',
    title: 'CIBC Ya Later',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 18 },
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  const rendererUrl = process.env.ELECTRON_RENDERER_URL
  const rendererPath = join(import.meta.dirname, '../renderer/index.html')
  const expectedUrl = new URL(rendererUrl ?? pathToFileURL(rendererPath).href).href
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, url) => {
    if (url !== expectedUrl) event.preventDefault()
  })
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false),
  )
  window.on('close', (event) => {
    if (!quitting) {
      event.preventDefault()
      window?.hide()
    }
  })
  window.once('ready-to-show', () => {
    if (!app.getLoginItemSettings().wasOpenedAtLogin) showWindow()
  })
  app.on('activate', showWindow)
  const handle = (channel: string, fn: (...args: unknown[]) => unknown) =>
    ipcMain.handle(channel, (event, ...args: unknown[]) => {
      if (
        event.sender !== window?.webContents ||
        event.senderFrame !== window.webContents.mainFrame ||
        event.senderFrame.url !== expectedUrl
      )
        throw new Error('Untrusted IPC request.')
      return fn(...args)
    })
  handle('state', () => state())
  handle('save-settings', (value) => {
    const settings = settingsSchema.parse(value)
    if (sync.busy) throw new Error('Wait for the active sync before changing settings.')
    if (settings.launchAtLogin && !app.isPackaged)
      throw new Error('Install the packaged app before enabling launch at login.')
    app.setLoginItemSettings({ openAtLogin: settings.launchAtLogin })
    if (JSON.stringify(settings.schedule) !== JSON.stringify(store.settings().schedule))
      store.set('scheduleCursor', String(Math.floor(Date.now() / 1000)))
    store.set('settings', JSON.stringify(settings))
    sync.tick(new Date(), canSync())
    change()
  })
  handle('sign-in', async (card, password, fullHistory) => {
    if (sync.busy || changingCredentials)
      throw new UserError('Wait for the active sync or credential change.')
    const values = credentialsSchema.parse({ card, password })
    const downloadFullHistory = z.boolean().parse(fullHistory)
    changingCredentials = true
    try {
      await vault.saveCredentials(values.card, values.password)
      store.set('cardLast4', values.card.slice(-4))
      hasCredentials = true
      sync.credentialsRejected = false
    } finally {
      changingCredentials = false
      change()
    }
    if (downloadFullHistory) void sync.startFullHistory()
    else void sync.refresh()
    change()
  })
  handle('sync', () => {
    if (canSync()) void sync.refresh()
  })
  handle('sign-out', async () => {
    if (sync.busy || changingCredentials)
      throw new UserError('Wait for the active sync or credential change.')
    changingCredentials = true
    try {
      await vault.clear()
      store.set('cardLast4', '')
      hasCredentials = false
      sync.credentialsRejected = false
    } finally {
      changingCredentials = false
      change()
    }
  })
  handle('download-full-history', () => {
    if (canSync()) void sync.startFullHistory()
  })
  handle('cancel-sync', () => sync.cancel())
  handle('submit-code', (code) => mfa.submit(codeSchema.parse(code), 'manual'))
  handle('connect-app', (label) => {
    const base = store.get('baseUrl') ?? ''
    if (!validBaseUrl(base) || !tailscale.serving || !apiState.running)
      throw new UserError("Tailscale Serve isn't ready.")
    const token = store.createToken(labelSchema.parse(label), base)
    change()
    return token
  })
  handle('revoke-app', (id) => {
    store.revokeClient(z.string().max(100).parse(id))
    change()
  })
  handle('close-account', (value) => {
    if (sync.busy) throw new UserError('Wait for the active sync.')
    const id = z.string().parse(value)
    store.closeAccount(id)
    sync.clearMissingAccount(id)
    if (canSync()) void sync.refresh()
  })
  handle('copy', (text) => {
    clipboard.writeText(z.string().max(8192).parse(text))
  })
  handle('export-shortcut', async () => {
    if (!window || window.isDestroyed()) throw new Error('Open the app window first.')
    const baseUrl = store.get('baseUrl') ?? ''
    if (!validBaseUrl(baseUrl) || !tailscale.serving || !apiState.running)
      throw new Error('Configure private Tailscale HTTPS before exporting the Shortcut.')
    const { canceled, filePath } = await dialog.showSaveDialog(window, {
      title: 'Export CIBC OTP Relay',
      defaultPath: join(app.getPath('downloads'), 'CIBC OTP Relay.shortcut'),
      filters: [{ name: 'Apple Shortcut', extensions: ['shortcut'] }],
    })
    if (canceled || !filePath) return false
    await exportRelayShortcut(baseUrl, filePath)
    shell.showItemInFolder(filePath)
    return true
  })
  const icon = nativeImage.createFromPath(trayIcon).resize({ width: 18, height: 18 })
  icon.setTemplateImage(true)
  tray = new Tray(icon)
  change()
  if (rendererUrl) await window.loadURL(rendererUrl)
  else await window.loadFile(rendererPath)
  const tick = () => {
    sync.tick(new Date(), canSync())
    change()
  }
  const scheduler = setInterval(tick, 30_000)
  const tailscalePoll = setInterval(() => {
    void updateTailscale().then(change)
  }, 60_000)
  // Check the schedule after startup and again after wake.
  const initial = setTimeout(tick, 30_000)
  powerMonitor.on('resume', tick)
  // Quit hides the window right away, gives an active sync up to 5 s to stop,
  // then exits even if cleanup is stuck (a pending Keychain prompt can't be
  // cancelled). Without the deadline, the app could sit half-quit in the menu bar.
  app.on('before-quit', (event) => {
    if (quitting) return
    event.preventDefault()
    quitting = true
    window?.hide()
    clearInterval(scheduler)
    clearInterval(tailscalePoll)
    clearTimeout(initial)
    mfa.cancel()
    api.closeAllConnections()
    mfaApi.closeAllConnections()
    api.close()
    mfaApi.close()
    void Promise.race([sync.stop(), new Promise((resolve) => setTimeout(resolve, 5000))])
      .catch(() => {})
      .finally(() => {
        try {
          store.close()
        } finally {
          app.exit(0)
        }
      })
  })
}
app.on('window-all-closed', () => {
  /* The tray and API intentionally stay alive. */
})
