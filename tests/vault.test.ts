import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const { decrypt, deleteCredential } = vi.hoisted(() => ({
  decrypt: vi.fn(),
  deleteCredential: vi.fn(async () => true),
}))
vi.mock('electron', () => ({ safeStorage: { decryptStringAsync: decrypt } }))
vi.mock('@napi-rs/keyring', () => ({
  AsyncEntry: class {
    deleteCredential = deleteCredential
  },
}))

import { Store } from '../src/main/store'
import { sampleAccount } from './helpers'

const { Vault } = await import('../src/main/vault')

function vaultWithSession() {
  const directory = mkdtempSync(join(tmpdir(), 'vault-'))
  writeFileSync(join(directory, 'session.enc'), 'ciphertext')
  return { directory, vault: new Vault(directory) }
}

describe('Vault session', () => {
  it('treats a session from another build as absent', async () => {
    decrypt.mockRejectedValueOnce(
      new Error(
        'Error while decrypting the ciphertext provided to safeStorage.decryptStringAsync.',
      ),
    )
    expect(await vaultWithSession().vault.session()).toBeUndefined()
  })
  it('surfaces Keychain failures', async () => {
    decrypt.mockRejectedValueOnce(new Error('User denied Keychain access'))
    await expect(vaultWithSession().vault.session()).rejects.toThrow('denied')
  })
  it('surfaces file read failures without decrypting', async () => {
    decrypt.mockClear()
    const { directory, vault } = vaultWithSession()
    chmodSync(join(directory, 'session.enc'), 0o000)
    await expect(vault.session()).rejects.toThrow(/EACCES/)
    expect(decrypt).not.toHaveBeenCalled()
  })
})

it('signs out by clearing credentials and session while keeping cached data', async () => {
  const { directory, vault } = vaultWithSession()
  const store = new Store(join(directory, 'db'))
  try {
    store.saveSnapshot([sampleAccount()], 1)
    store.set('settings', JSON.stringify({ ...store.settings(), launchAtLogin: true }))
    store.createToken('Actual', 'https://mac.tailnet.ts.net/simplefin')
    const before = {
      accounts: store.accountSummary(),
      apps: store.clients(),
      settings: store.settings(),
    }
    await vault.clear()
    expect(deleteCredential).toHaveBeenCalled()
    expect(existsSync(join(directory, 'session.enc'))).toBe(false)
    expect({
      accounts: store.accountSummary(),
      apps: store.clients(),
      settings: store.settings(),
    }).toEqual(before)
    await vault.clear()
  } finally {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
