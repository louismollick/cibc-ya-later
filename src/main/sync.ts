import type { SyncBlocker, SyncPhase, SyncStatus } from '../shared/types'
import type { CibcDownloader } from './cibc'
import {
  CibcRefusedSignIn,
  CredentialsRejected,
  HistoryGap,
  MissingAccount,
  UserError,
} from './errors'
import { scheduleWindow } from './schedule'
import { LOOKBACK_DAYS, type Store } from './store'

type Downloader = Pick<CibcDownloader, 'download' | 'backfill' | 'cancel'>
export class SyncService {
  private active: Promise<void> | null = null
  private generation = 0
  private cancelRetry: (() => void) | null = null
  blocker: SyncBlocker | null = null
  fullHistoryRunning = false
  readonly status: SyncStatus
  constructor(
    private readonly store: Store,
    private readonly downloader: Downloader,
    private readonly change: () => void,
    private readonly canRun: () => boolean = () => true,
  ) {
    this.status = {
      phase: 'idle',
      message: '',
      lastSuccess: store.lastSuccess(),
      nextAttempt: scheduleWindow(store.settings().schedule).next,
      codeExpiresAt: null,
    }
  }
  update(phase: SyncPhase, message: string, codeExpiresAt: number | null = null) {
    this.status.phase = phase
    this.status.message = message
    this.status.codeExpiresAt = codeExpiresAt
    this.change()
  }
  get credentialsRejected() {
    return this.store.get('credentialsRejected') === 'true'
  }
  set credentialsRejected(rejected: boolean) {
    this.store.set('credentialsRejected', String(rejected))
  }
  private get eligible() {
    return !this.credentialsRejected && this.canRun()
  }
  get busy() {
    return this.active !== null
  }
  refresh(): Promise<void> {
    if (this.active) return this.active
    if (!this.eligible) return Promise.resolve()
    return this.run(false)
  }
  startFullHistory(): Promise<void> {
    if (this.busy) throw new UserError('Wait for the active download.')
    if (!this.eligible) return Promise.resolve()
    return this.run(true)
  }
  clearMissingAccount(id: string) {
    if (this.blocker?.kind === 'missing-account' && this.blocker.accountId === id)
      this.blocker = null
  }
  private run(fullHistory: boolean) {
    const generation = this.generation
    this.blocker = null
    this.fullHistoryRunning = fullHistory
    this.status.phase = 'signing-in'
    this.status.message = 'Signing in'
    this.status.codeExpiresAt = null
    this.active = Promise.resolve()
      .then(async () => {
        const check = () => {
          if (generation !== this.generation) throw new UserError('Sync cancelled.')
        }
        check()
        const coverage = this.store.coverage().map((a) => a.coverageEnd)
        const since = coverage.length ? Math.min(...coverage) : undefined
        const download = () =>
          fullHistory ? this.downloader.backfill() : this.downloader.download(LOOKBACK_DAYS, since)
        const accounts = await download().catch(async (error: unknown) => {
          if (fullHistory || !(error instanceof CibcRefusedSignIn)) throw error
          check()
          this.update('signing-in', 'Retrying sign-in')
          await this.waitForRetry()
          check()
          return download()
        })
        check()
        this.store.saveSnapshot(
          accounts,
          accounts.length,
          Math.floor(Date.now() / 1000),
          fullHistory,
        )
        this.blocker = null
        this.status.lastSuccess = this.store.lastSuccess()
        this.status.phase = 'idle'
        this.status.message = ''
      })
      .catch((error: unknown) => {
        if (generation !== this.generation) {
          this.status.phase = 'idle'
          this.status.message = ''
          return
        }
        if (error instanceof CredentialsRejected) this.credentialsRejected = true
        if (error instanceof MissingAccount)
          this.blocker = { kind: 'missing-account', accountId: error.accountId, name: error.name }
        if (error instanceof HistoryGap) this.blocker = { kind: 'history-gap' }
        this.status.phase = 'error'
        this.status.message = error instanceof UserError ? error.message : 'Sync failed.'
      })
      .finally(() => {
        this.status.codeExpiresAt = null
        this.fullHistoryRunning = false
        this.active = null
        this.change()
      })
    this.change()
    return this.active
  }
  private waitForRetry() {
    return new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer)
        this.cancelRetry = null
        resolve()
      }
      const timer = setTimeout(finish, 60_000)
      this.cancelRetry = finish
    })
  }
  async cancel() {
    this.generation++
    this.cancelRetry?.()
    await this.downloader.cancel()
  }
  async stop() {
    await this.cancel()
    await this.active
  }
  tick(now = new Date(), canRun = true) {
    const { previous, next } = scheduleWindow(this.store.settings().schedule, now)
    this.status.nextAttempt = next
    if (!previous || this.busy || !canRun || !this.eligible) return
    const cursor = Number(this.store.get('scheduleCursor') ?? '0')
    if (previous <= cursor) return
    // Collapse missed occurrences into one run, including after restarting.
    this.store.set('scheduleCursor', String(previous))
    if ((this.store.lastSuccess() ?? 0) >= previous) return
    void this.refresh()
  }
}
