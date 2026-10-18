import { randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import Database from 'better-sqlite3'
import { and, asc, eq, gte, inArray, lt } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import type { AccountSummary, DownloadedAccount, Settings } from '../shared/types'
import { HistoryGap, MissingAccount, UserError } from './errors'
import { digest, money } from './ofx'
import * as schema from './schema'
import { settingsSchema } from './validation'

export const LOOKBACK_DAYS = 60
export const defaults: Settings = {
  schedule: { weekdays: [0, 1, 2, 3, 4, 5, 6], time: '07:00' },
  launchAtLogin: false,
}
export class Store {
  readonly sqlite: Database.Database
  readonly db
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.sqlite = new Database(path)
    if (path !== ':memory:') chmodSync(path, 0o600)
    this.sqlite.pragma('journal_mode = WAL')
    this.sqlite.pragma('foreign_keys = ON')
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, sourceHash TEXT NOT NULL, name TEXT NOT NULL, currency TEXT NOT NULL, balance TEXT NOT NULL, balanceDate INTEGER NOT NULL, coverageStart INTEGER NOT NULL, coverageEnd INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS transactions (id TEXT PRIMARY KEY, accountId TEXT NOT NULL REFERENCES accounts(id), posted INTEGER NOT NULL, amount TEXT NOT NULL, description TEXT NOT NULL, pending INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS transaction_dates ON transactions(accountId, posted);
      CREATE TABLE IF NOT EXISTS clients (id TEXT PRIMARY KEY, label TEXT NOT NULL, tokenHash TEXT UNIQUE, secretHash TEXT, createdAt INTEGER NOT NULL, expiresAt INTEGER, claimedAt INTEGER, lastUsed INTEGER);
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      PRAGMA user_version = 1;
    `)
    // Earlier versions kept only a hash, so existing account numbers cannot be recovered.
    const columns = this.sqlite.pragma('table_info(accounts)') as { name: string }[]
    if (!columns.some((column) => column.name === 'last4'))
      this.sqlite.exec("ALTER TABLE accounts ADD COLUMN last4 TEXT NOT NULL DEFAULT ''")
    this.db = drizzle(this.sqlite, { schema })
    this.fullHistoryCompletedAt()
  }
  get(key: string): string | undefined {
    return this.db.select().from(schema.meta).where(eq(schema.meta.key, key)).get()?.value
  }
  set(key: string, value: string) {
    this.db
      .insert(schema.meta)
      .values({ key, value })
      .onConflictDoUpdate({ target: schema.meta.key, set: { value } })
      .run()
  }
  settings(): Settings {
    try {
      return (
        settingsSchema.safeParse({ ...defaults, ...JSON.parse(this.get('settings') ?? '{}') })
          .data ?? structuredClone(defaults)
      )
    } catch {
      return structuredClone(defaults)
    }
  }
  lastSuccess(): number | null {
    const t = this.get('lastSuccess')
    return t ? Number(t) : null
  }
  fullHistoryCompletedAt(): number | null {
    const saved = this.get('fullHistoryCompletedAt')
    if (saved) return Number(saved)
    try {
      const old: unknown = JSON.parse(this.get('backfill') ?? 'null')
      if (old && typeof old === 'object' && 'status' in old && old.status === 'complete') {
        const completedAt = this.lastSuccess() ?? Math.floor(Date.now() / 1000)
        this.set('fullHistoryCompletedAt', String(completedAt))
        return completedAt
      }
    } catch {
      /* Ignore obsolete corrupt job metadata. */
    }
    return null
  }
  coverage() {
    return this.db
      .select()
      .from(schema.accounts)
      .all()
      .filter((a) => !this.closedAccounts().includes(a.id))
  }
  saveSnapshot(
    accounts: DownloadedAccount[],
    expectedCount: number,
    now = Math.floor(Date.now() / 1000),
    fullHistory = false,
  ) {
    if (
      !accounts.length ||
      accounts.length !== expectedCount ||
      new Set(accounts.map((a) => a.id)).size !== expectedCount
    )
      throw new UserError('Incomplete account download. Cache was not changed.')
    for (const account of accounts) {
      money(account.balance)
      if (
        !account.id ||
        !account.name ||
        !account.sourceId ||
        account.coverageStart >= account.coverageEnd ||
        account.balanceDate > now + 86400
      )
        throw new UserError('Invalid account snapshot.')
      const ids = new Set<string>()
      for (const t of account.transactions) {
        money(t.amount)
        if (
          !t.id ||
          ids.has(t.id) ||
          !t.description ||
          !Number.isSafeInteger(t.posted) ||
          t.posted < account.coverageStart ||
          t.posted >= account.coverageEnd
        )
          throw new UserError('Invalid transaction snapshot.')
        ids.add(t.id)
      }
    }
    const previous = this.db.select().from(schema.accounts).all()
    const missing = previous.find(
      (a) => !this.closedAccounts().includes(a.id) && !accounts.some((b) => b.id === a.id),
    )
    if (missing) throw new MissingAccount(missing.id, missing.name)
    this.db.transaction((tx) => {
      for (const account of accounts) {
        const old = previous.find((a) => a.id === account.id)
        if (
          old &&
          (account.coverageStart > old.coverageEnd || account.coverageEnd < old.coverageStart)
        )
          throw new HistoryGap()
        const { transactions, sourceId, ...data } = account
        if (
          old &&
          (old.currency !== account.currency ||
            old.sourceHash !== digest(sourceId.replace(/\D/g, '')))
        )
          throw new UserError('CIBC account identity changed. Cache was not changed.')
        // Preserve history outside the rolling download. Within verified coverage,
        // fail if a bank removes an already imported transaction without a correction.
        const prior = tx
          .select()
          .from(schema.transactions)
          .where(
            and(
              eq(schema.transactions.accountId, account.id),
              gte(schema.transactions.posted, account.coverageStart),
              lt(schema.transactions.posted, account.coverageEnd),
            ),
          )
          .all()
        if (prior.some((p) => !transactions.some((t) => t.id === p.id)))
          throw new UserError(
            'CIBC export omitted previously downloaded transactions. Cache was not changed.',
          )
        const row = {
          ...data,
          sourceHash: digest(sourceId.replace(/\D/g, '')),
          last4: sourceId.replace(/\D/g, '').slice(-4),
          coverageStart: Math.min(old?.coverageStart ?? data.coverageStart, data.coverageStart),
        }
        tx.insert(schema.accounts)
          .values(row)
          .onConflictDoUpdate({ target: schema.accounts.id, set: row })
          .run()
        for (const transaction of transactions) {
          const existing = tx
            .select()
            .from(schema.transactions)
            .where(eq(schema.transactions.id, transaction.id))
            .get()
          if (
            existing &&
            (existing.accountId !== account.id ||
              existing.posted !== transaction.posted ||
              existing.amount !== transaction.amount)
          )
            throw new UserError('CIBC changed an imported transaction. Review required.')
          const row = { ...transaction, accountId: account.id }
          tx.insert(schema.transactions)
            .values(row)
            .onConflictDoUpdate({ target: schema.transactions.id, set: row })
            .run()
        }
      }
      tx.insert(schema.meta)
        .values({ key: 'lastSuccess', value: String(now) })
        .onConflictDoUpdate({ target: schema.meta.key, set: { value: String(now) } })
        .run()
      const reopened = this.closedAccounts().filter((id) => !accounts.some((a) => a.id === id))
      this.set('retiredAccounts', JSON.stringify(reopened))
      if (fullHistory) this.set('fullHistoryCompletedAt', String(now))
    })
  }
  accountSummary(): AccountSummary[] {
    return this.coverage().map(({ id, name, last4, currency, balance, balanceDate }) => ({
      id,
      name,
      last4,
      currency,
      balance,
      balanceDate,
    }))
  }
  // Keep the old metadata key so existing closed accounts retain their state.
  closedAccounts(): string[] {
    return JSON.parse(this.get('retiredAccounts') ?? '[]')
  }
  closeAccount(id: string) {
    if (!this.db.select().from(schema.accounts).where(eq(schema.accounts.id, id)).get())
      throw new UserError('Account was not found.')
    this.set('retiredAccounts', JSON.stringify([...new Set([...this.closedAccounts(), id])]))
  }
  accountSet(
    baseUrl: string,
    query: {
      start?: number
      end?: number
      accounts: string[]
      pending: boolean
      balancesOnly: boolean
    },
  ) {
    const accounts = this.db
      .select()
      .from(schema.accounts)
      .where(query.accounts.length ? inArray(schema.accounts.id, query.accounts) : undefined)
      .all()
    return accounts
      .filter((a) => !this.closedAccounts().includes(a.id))
      .map((a) => ({
        org: { name: 'CIBC', domain: 'cibc.com', 'sfin-url': baseUrl },
        id: a.id,
        name: a.name,
        currency: a.currency,
        balance: a.balance,
        'balance-date': a.balanceDate,
        ...(!query.balancesOnly
          ? {
              transactions: this.db
                .select({
                  id: schema.transactions.id,
                  posted: schema.transactions.posted,
                  amount: schema.transactions.amount,
                  description: schema.transactions.description,
                  pending: schema.transactions.pending,
                })
                .from(schema.transactions)
                .where(
                  and(
                    eq(schema.transactions.accountId, a.id),
                    query.start !== undefined
                      ? gte(schema.transactions.posted, query.start)
                      : undefined,
                    query.end !== undefined ? lt(schema.transactions.posted, query.end) : undefined,
                    query.pending ? undefined : eq(schema.transactions.pending, false),
                  ),
                )
                .orderBy(asc(schema.transactions.posted), asc(schema.transactions.id))
                .all(),
            }
          : {}),
      }))
  }
  createToken(label: string, baseUrl: string, now = Math.floor(Date.now() / 1000)) {
    const token = randomBytes(32).toString('base64url')
    const id = `sync-${randomBytes(12).toString('hex')}`
    this.db
      .insert(schema.clients)
      .values({ id, label, tokenHash: digest(token), createdAt: now, expiresAt: now + 900 })
      .run()
    return Buffer.from(`${baseUrl}/claim/${token}`).toString('base64')
  }
  claim(token: string, baseUrl: string, now = Math.floor(Date.now() / 1000)): string | null {
    return this.db.transaction((tx) => {
      const client = tx
        .select()
        .from(schema.clients)
        .where(eq(schema.clients.tokenHash, digest(token)))
        .get()
      if (
        !client ||
        client.claimedAt !== null ||
        client.expiresAt === null ||
        client.expiresAt <= now
      )
        return null
      const secret = randomBytes(32).toString('base64url')
      tx.update(schema.clients)
        .set({ secretHash: digest(secret), tokenHash: null, claimedAt: now, expiresAt: null })
        .where(eq(schema.clients.id, client.id))
        .run()
      const url = new URL(baseUrl)
      url.username = client.id
      url.password = secret
      return url.toString()
    })
  }
  authenticate(username: string, secret: string): boolean {
    const client = this.db
      .select()
      .from(schema.clients)
      .where(eq(schema.clients.id, username))
      .get()
    const actual = Buffer.from(digest(secret), 'hex')
    const expected = Buffer.from(client?.secretHash ?? '0'.repeat(64), 'hex')
    const valid = timingSafeEqual(actual, expected) && client?.secretHash != null
    if (valid)
      this.db
        .update(schema.clients)
        .set({ lastUsed: Math.floor(Date.now() / 1000) })
        .where(eq(schema.clients.id, username))
        .run()
    return valid
  }
  clients() {
    return this.db
      .select()
      .from(schema.clients)
      .all()
      .map((c) => ({
        id: c.id,
        label: c.label,
        createdAt: c.createdAt,
        lastUsed: c.lastUsed,
        claimed: c.claimedAt !== null,
        expiresAt: c.expiresAt,
      }))
  }
  revokeClient(id: string) {
    this.db.delete(schema.clients).where(eq(schema.clients.id, id)).run()
  }
  close() {
    this.sqlite.close()
  }
}
