import assert from 'node:assert/strict'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron } from 'playwright'

// Run with the app stopped. Tests the export without changing saved preferences.
const directory = await mkdtemp(join(tmpdir(), 'cibc-relay-ui-'))
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const desktop = await electron.launch({
  ...(process.env.CIBC_APP_EXECUTABLE
    ? { executablePath: process.env.CIBC_APP_EXECUTABLE, args: [] }
    : { args: ['.'] }),
  env,
})
try {
  const page = await desktop.firstWindow()
  await page.waitForFunction(() => Boolean(window.cibc))
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const button = page.getByRole('button', { name: 'Export signed Shortcut', exact: true })
  await button.waitFor()
  assert.equal(await button.isEnabled(), true)
  assert.equal(await page.getByText('Copy setup secret', { exact: true }).count(), 0)
  const path = join(directory, 'Relay.shortcut')
  await desktop.evaluate(({ dialog, shell }, filePath) => {
    globalThis.relaySmokeOriginals = { save: dialog.showSaveDialog, reveal: shell.showItemInFolder }
    dialog.showSaveDialog = async () => ({ canceled: false, filePath })
    shell.showItemInFolder = () => {}
  }, path)
  try {
    assert.equal(await page.evaluate(() => window.cibc.exportMfaShortcut()), true)
    assert.ok((await stat(path)).size > 0)
    assert.equal((await stat(path)).mode & 0o777, 0o600)
  } finally {
    await desktop.evaluate(({ dialog, shell }) => {
      dialog.showSaveDialog = globalThis.relaySmokeOriginals.save
      shell.showItemInFolder = globalThis.relaySmokeOriginals.reveal
      delete globalThis.relaySmokeOriginals
    })
  }
  const state = await page.evaluate(() => window.cibc.state())
  assert.notEqual(state.sync.phase, 'mfa', 'Wait for the real CIBC login before testing the relay.')
  const endpoint = new URL('/internal/mfa/code', state.simplefinUrl)
  endpoint.port = '8443'
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: 'not-a-code' }),
  })
  assert.equal(response.status, 409)
  await page.screenshot({ path: '/tmp/cibc-relay-settings.png', fullPage: true })
  console.log(
    'Installed UI and export IPC, native signing, output permissions, and private HTTPS MFA passed.',
  )
} finally {
  await rm(directory, { recursive: true, force: true })
  // Close the test instance. Start the app normally afterward.
  await desktop.close()
}
