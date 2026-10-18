import assert from 'node:assert/strict'
import { _electron as electron } from 'playwright'

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const desktop = await electron.launch({
  ...(process.env.CIBC_APP_EXECUTABLE
    ? { executablePath: process.env.CIBC_APP_EXECUTABLE, args: [] }
    : { args: ['.'] }),
  env,
})
let page, clientId
try {
  const trayImage = await desktop.evaluate(({ app, nativeImage }) => {
    const icon = nativeImage.createFromPath(`${app.getAppPath()}/resources/trayTemplate.png`)
    return { empty: icon.isEmpty(), size: icon.getSize() }
  })
  assert.equal(trayImage.empty, false, 'Tray icon must be included in the packaged app')
  assert.deepEqual(trayImage.size, { width: 36, height: 36 })
  page = await desktop.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForFunction(() => Boolean(window.cibc))
  const initial = await page.evaluate(() => window.cibc.state())
  assert.equal(initial.api.running, true)
  assert.ok(initial.simplefinUrl)
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined')
  const encryption = await desktop.evaluate(async ({ safeStorage }) => {
    const encrypted = await safeStorage.encryptStringAsync('isolated encryption test')
    const decrypted = await safeStorage.decryptStringAsync(encrypted)
    return (
      decrypted.result === 'isolated encryption test' &&
      !encrypted.includes(Buffer.from('isolated encryption test'))
    )
  })
  assert.equal(encryption, true)
  // The schedule UI is only reachable once signed in.
  if (initial.credentials === 'saved') {
    await page.getByRole('button', { name: /^Settings/ }).click()
    for (const day of [
      'Monday',
      'Wednesday',
      'Thursday',
      'Saturday',
      'Sunday',
      'Tuesday',
      'Friday',
    ]) {
      const button = page.getByRole('button', { name: day, exact: true })
      const want = day === 'Tuesday' || day === 'Friday'
      if (((await button.getAttribute('aria-pressed')) === 'true') !== want) {
        await button.click()
        await page.waitForFunction(
          async ([d, w]) =>
            (await window.cibc.state()).settings.schedule.weekdays.includes(d) === w,
          [
            ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].indexOf(
              day,
            ),
            want,
          ],
        )
      }
    }
    await page.getByLabel('Sync time', { exact: true }).fill('10:00')
    await page.waitForFunction(
      async () => (await window.cibc.state()).settings.schedule.time === '10:00',
    )
    const configured = await page.evaluate(() => window.cibc.state())
    assert.deepEqual(configured.settings.schedule.weekdays.sort(), [2, 5])
    await page.evaluate((settings) => window.cibc.saveSettings(settings), initial.settings)
  }
  const local = 'http://127.0.0.1:3610'
  assert.equal((await fetch(`${initial.simplefinUrl}/info`)).status, 200)
  const token = await page.evaluate(() => window.cibc.connectApp('Temporary smoke test'))
  const claim = new URL(Buffer.from(token, 'base64').toString())
  const claimed = await fetch(`${local}${claim.pathname}`, { method: 'POST' })
  assert.equal(claimed.status, 200)
  const access = new URL(await claimed.text())
  clientId = access.username
  assert.equal((await fetch(`${local}${claim.pathname}`, { method: 'POST' })).status, 403)
  const authorization = `Basic ${Buffer.from(`${access.username}:${access.password}`).toString('base64')}`
  const response = await fetch(`${local}/simplefin/accounts?balances-only=1`, {
    headers: { authorization },
  })
  assert.equal(response.status, initial.accounts.length ? 200 : 503)
  const result = await response.json()
  assert.equal(result.accounts.length, initial.accounts.length)
  assert.ok(result.accounts.every((a) => !('transactions' in a)))
  await page.evaluate((id) => window.cibc.revokeApp(id), clientId)
  clientId = undefined
  assert.equal(
    (await fetch(`${local}/simplefin/accounts`, { headers: { authorization } })).status,
    403,
  )
  await page.screenshot({ path: '/tmp/cibc-ya-later.png' })
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close())
  assert.equal(
    await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible()),
    false,
  )
  assert.equal((await fetch(`${local}/simplefin/info`)).status, 200)
  console.log(
    JSON.stringify({
      desktopBridge: 'passed',
      keychainEncryption: 'passed',
      scheduleUI: 'passed',
      privateHTTPS: 'passed',
      claimAndRevoke: 'passed',
      closeWindowKeepsAPI: 'passed',
      cachedAccounts: initial.accounts.length,
    }),
  )
} finally {
  if (clientId && page)
    await page.evaluate((id) => window.cibc.revokeApp(id), clientId).catch(() => {})
  await desktop.close()
}
