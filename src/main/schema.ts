import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
export const accounts = sqliteTable('accounts', {
  id: text().primaryKey(),
  sourceHash: text().notNull(),
  last4: text().notNull().default(''),
  name: text().notNull(),
  currency: text().notNull(),
  balance: text().notNull(),
  balanceDate: integer().notNull(),
  coverageStart: integer().notNull(),
  coverageEnd: integer().notNull(),
})
export const transactions = sqliteTable('transactions', {
  id: text().primaryKey(),
  accountId: text()
    .notNull()
    .references(() => accounts.id),
  posted: integer().notNull(),
  amount: text().notNull(),
  description: text().notNull(),
  pending: integer({ mode: 'boolean' }).notNull(),
})
export const clients = sqliteTable('clients', {
  id: text().primaryKey(),
  label: text().notNull(),
  tokenHash: text().unique(),
  secretHash: text(),
  createdAt: integer().notNull(),
  expiresAt: integer(),
  claimedAt: integer(),
  lastUsed: integer(),
})
export const meta = sqliteTable('meta', { key: text().primaryKey(), value: text().notNull() })
