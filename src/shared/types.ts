export type Transaction = {
  id: string
  posted: number
  amount: string
  description: string
  pending: boolean
}

export type DownloadedAccount = {
  id: string
  sourceId: string
  name: string
  currency: string
  balance: string
  balanceDate: number
  coverageStart: number
  coverageEnd: number
  transactions: Transaction[]
}

export type Settings = {
  // Always on; at least one weekday. Times follow the Mac's local timezone.
  schedule: { weekdays: number[]; time: string }
  launchAtLogin: boolean
}
// signing-in covers the first 45 s of a code challenge, while the iPhone relay
// has a chance to deliver. code-needed means the relay missed it.
export type SyncPhase = 'idle' | 'signing-in' | 'syncing' | 'code-needed' | 'error'
export type SyncStatus = {
  phase: SyncPhase
  // Progress or a short error sentence written by the app, never bank text.
  message: string
  lastSuccess: number | null
  nextAttempt: number | null
  // Unix seconds when the current code challenge expires, while code-needed.
  codeExpiresAt: number | null
}
// Why the last sync could not publish, when the owner can act on it.
export type SyncBlocker =
  | { kind: 'missing-account'; accountId: string; name: string }
  | { kind: 'history-gap' }
export type ConnectedApp = {
  id: string
  label: string
  createdAt: number
  lastUsed: number | null
  claimed: boolean
  expiresAt: number | null
}
export type AccountSummary = {
  id: string
  name: string
  last4: string
  currency: string
  balance: string
  balanceDate: number
}
export type AppState = {
  settings: Settings
  sync: SyncStatus
  blocker: SyncBlocker | null
  // rejected: CIBC refused the saved password; the sign-in form returns.
  credentials: 'none' | 'saved' | 'rejected'
  cardLast4: string | null
  fullHistory: { completedAt: number | null; running: boolean }
  accounts: AccountSummary[]
  apps: ConnectedApp[]
  // Null until Tailscale Serve is configured.
  simplefinUrl: string | null
  tailscaleError: string | null
  api: { running: boolean; error: string | null }
}
export type DesktopApi = {
  state(): Promise<AppState>
  saveSettings(settings: Settings): Promise<void>
  // Saves credentials, then starts the first sync (full history when asked).
  signIn(card: string, password: string, fullHistory: boolean): Promise<void>
  signOut(): Promise<void>
  sync(): Promise<void>
  downloadFullHistory(): Promise<void>
  cancelSync(): Promise<void>
  submitCode(code: string): Promise<void>
  // Returns a one-time setup token for the app to claim.
  connectApp(label: string): Promise<string>
  revokeApp(id: string): Promise<void>
  closeAccount(id: string): Promise<void>
  copy(text: string): Promise<void>
  exportShortcut(): Promise<boolean>
  onChange(listener: () => void): () => void
}
