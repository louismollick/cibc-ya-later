import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { AsyncEntry } from '@napi-rs/keyring'
import { safeStorage } from 'electron'
import { z } from 'zod'
import { credentialsSchema } from './validation'

export class Vault {
  constructor(private readonly directory: string) {}
  private entry(key: string) {
    return new AsyncEntry('ca.louismollick.cibc-ya-later', key)
  }
  async credentials() {
    const value = await this.entry('cibc-login').getPassword()
    return value ? credentialsSchema.parse(JSON.parse(value)) : null
  }
  async saveCredentials(card: string, password: string) {
    await this.entry('cibc-login').setPassword(
      JSON.stringify(credentialsSchema.parse({ card, password })),
    )
  }
  async clear() {
    await this.entry('cibc-login').deleteCredential()
    rmSync(join(this.directory, 'session.enc'), { force: true })
  }
  hasSession() {
    return existsSync(join(this.directory, 'session.enc'))
  }
  // A session encrypted by another build (dev vs. packaged) can't be decrypted.
  // Treat only that as absent, so the next sync signs in fresh with saved
  // credentials. File and Keychain access errors still surface.
  async session() {
    if (!this.hasSession()) return undefined
    const encrypted = readFileSync(join(this.directory, 'session.enc'))
    try {
      const { result } = await safeStorage.decryptStringAsync(encrypted)
      return z.string().parse(result)
    } catch (error) {
      if (error instanceof Error && /decrypting the ciphertext/.test(error.message))
        return undefined
      throw error
    }
  }
  async saveSession(value: string) {
    if (!(await safeStorage.isAsyncEncryptionAvailable()))
      throw new Error('macOS Keychain encryption is unavailable. Session was not saved.')
    const encrypted = await safeStorage.encryptStringAsync(value)
    const path = join(this.directory, 'session.enc')
    writeFileSync(`${path}.tmp`, encrypted, { mode: 0o600 })
    renameSync(`${path}.tmp`, path)
  }
}
