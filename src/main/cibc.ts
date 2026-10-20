import { existsSync, readdirSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  type Browser,
  type BrowserContextOptions,
  chromium,
  type Download,
  type Page,
} from 'playwright'
import { z } from 'zod'
import type { DownloadedAccount, SyncPhase } from '../shared/types'
import { CibcRefusedSignIn, CredentialsRejected, UserError } from './errors'
import type { Log } from './log'
import type { MfaGate } from './mfa'
import { accountId, money, parseOfx } from './ofx'

export const signOnUrl =
  'https://www.cibconline.cibc.com/ebm-resources/public/banking/cibc/client/web/index.html#/signon'
export const downloadUrl =
  'https://www.cibconline.cibc.com/ebm-resources/public/banking/cibc/client/web/index.html#/accounts/download'
const credentials = z.object({ card: z.string(), password: z.string() })
export type CibcOptions = {
  browserRoot: string
  session: () => Promise<string | undefined>
  saveSession: (state: string) => Promise<void>
  credentials: () => Promise<z.infer<typeof credentials> | null>
  mfa: MfaGate
  status: (phase: SyncPhase, message: string, codeExpiresAt?: number) => void
  /** Folder for the last failed run's screenshot and trace. Never shown in the UI. */
  diagnostics?: string
  /** Receives every trace event, on success and failure. */
  log?: Log
}
type Trace = (event: string) => void
type StorageState = Exclude<NonNullable<BrowserContextOptions['storageState']>, string>
// Akamai Bot Manager cookies hold a bot score. Once a saved score goes stale,
// CIBC refuses every sign-in that reuses it (403 at the card step), so never restore them.
const botCookie = /^(_abck|ak_bmsc|bm_\w+)$/
// Drops query strings, which can carry session tokens.
const tracedUrl = (url: string) => {
  const u = new URL(url)
  return `${u.origin}${u.pathname}${u.hash}`
}
export function browserExecutable(root: string) {
  if (!existsSync(root))
    throw new UserError(
      'CIBC browser is missing. Run pnpm run browser:install and rebuild the app.',
    )
  const folder = readdirSync(root).find((n) => /^chromium-\d+$/.test(n))
  if (!folder) throw new UserError('CIBC browser is missing. Reinstall the app.')
  const path = join(
    root,
    folder,
    `chrome-mac-${process.arch === 'arm64' ? 'arm64' : 'x64'}`,
    'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  )
  if (!existsSync(path))
    throw new UserError('The bundled CIBC browser is not compatible with this Mac.')
  return path
}
export function bankDateRange(days: number, now = new Date()) {
  const today = now.toLocaleDateString('en-CA', { timeZone: 'America/Toronto' })
  const end = new Date(`${today}T00:00:00Z`)
  const start = new Date(end)
  start.setUTCDate(start.getUTCDate() - days)
  return {
    from: start.toISOString().slice(0, 10),
    to: today,
    start: Math.floor(start.getTime() / 1000),
    end: Math.floor(end.getTime() / 1000) + 86400,
  }
}

export class CibcDownloader {
  private browser: Browser | null = null
  private generation = 0
  constructor(private readonly options: CibcOptions) {}
  async cancel() {
    this.generation++
    this.options.mfa.cancel()
    await this.browser?.close()
  }
  private check(generation: number) {
    if (generation !== this.generation) throw new UserError('CIBC operation cancelled.')
  }
  private async open(generation: number) {
    // Read/decrypt before launch so a locked Keychain never leaves a browser open.
    const state = await this.options.session()
    this.check(generation)
    const storageState: StorageState | undefined = state ? JSON.parse(state) : undefined
    if (storageState)
      storageState.cookies = storageState.cookies.filter((c) => !botCookie.test(c.name))
    // The full Chrome build runs in new headless mode, so it never takes focus.
    // CIBC resets connections whose user agent says HeadlessChrome, so send the
    // same reduced user agent headed Chrome sends.
    this.browser = await chromium.launch({
      executablePath: browserExecutable(this.options.browserRoot),
      headless: true,
      chromiumSandbox: true,
    })
    this.check(generation)
    const major = this.browser.version().split('.')[0]
    const context = await this.browser.newContext({
      storageState,
      acceptDownloads: true,
      viewport: { width: 1280, height: 900 },
      locale: 'en-CA',
      userAgent: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`,
    })
    this.check(generation)
    // Match headed Chrome's screen and window metrics for CIBC's bot detection checks.
    await context.addInitScript(() => {
      Object.defineProperties(Screen.prototype, {
        colorDepth: { get: () => 30 },
        pixelDepth: { get: () => 30 },
      })
      Object.defineProperties(window, {
        outerWidth: { get: () => innerWidth },
        outerHeight: { get: () => innerHeight + 87 },
      })
    })
    this.check(generation)
    context.setDefaultTimeout(15_000)
    return context
  }
  private trusted(page: Page) {
    const u = new URL(page.url())
    if (u.protocol !== 'https:' || !(u.hostname === 'cibc.com' || u.hostname.endsWith('.cibc.com')))
      throw new UserError('CIBC redirected to an unexpected sign-in site.')
  }
  private async loggedIn(page: Page) {
    return page
      .locator('main select')
      .filter({ has: page.locator('option[value="MONEY"]') })
      .count()
      .then((c) => c > 0)
  }
  private async signIn(page: Page, generation: number, trace: Trace) {
    this.trusted(page)
    if (await this.loggedIn(page)) return false
    this.options.status('signing-in', 'Signing in')
    let stored: Awaited<ReturnType<CibcOptions['credentials']>> = null
    let filledCard = false,
      filledPassword = false,
      submittedMfa = false,
      retries = 0
    const deadline = Date.now() + 240_000
    while (Date.now() < deadline) {
      if (await this.loggedIn(page)) return true
      this.trusted(page)
      if (
        await page
          .getByText(/there['’]s been an error|Result #0001/i)
          .filter({ visible: true })
          .count()
      ) {
        trace('CIBC error page shown')
        // CIBC randomly refuses about 1 in 10 card numbers. Only the card has
        // been sent, so start over with fresh cookies. Never retry a password.
        if (!filledCard || filledPassword || retries === 2) throw new CibcRefusedSignIn()
        retries++
        filledCard = false
        await page.context().clearCookies()
        await page.waitForTimeout(3000)
        await page.goto(downloadUrl, { waitUntil: 'domcontentloaded' })
        continue
      }
      // Match visible credential errors after submitting the card or password.
      if (
        (filledCard || filledPassword) &&
        (await page
          .getByText(
            /(card number|password)[^.]{0,80}(incorrect|invalid|not valid|does not match|doesn't match)/i,
          )
          .filter({ visible: true })
          .count())
      )
        throw new CredentialsRejected()
      const card = page.getByRole('textbox', { name: /^Card number$/i })
      const password = page.locator('input[type="password"]')
      const code = page
        .getByRole('textbox', { name: /^Enter the [68]-digit verification code$/i })
        .or(
          page.locator(
            'input[autocomplete="one-time-code"], input[inputmode="numeric"][maxlength="6"], input[id*="verificationCode"], input[name*="verificationCode"]',
          ),
        )
      if (!filledCard && (await card.isVisible().catch(() => false))) {
        stored ??= await this.options.credentials()
        if (!stored) throw new UserError('Save your CIBC credentials to sign in.')
        await card.fill(stored.card)
        filledCard = true
        await page.getByRole('button', { name: /^Continue$/i }).click()
        trace('card submitted')
      } else if (
        !filledPassword &&
        (await password
          .first()
          .isVisible()
          .catch(() => false))
      ) {
        stored ??= await this.options.credentials()
        if (!stored) throw new UserError('CIBC credentials are required to refresh this session.')
        await password.first().fill(stored.password)
        filledPassword = true
        const button = page
          .getByRole('button', { name: /^(Sign on|Sign in|Continue)$/i })
          .filter({ visible: true })
          .first()
        await button.click()
        trace('password submitted')
      } else if (
        !submittedMfa &&
        (await code
          .first()
          .isVisible()
          .catch(() => false))
      ) {
        this.check(generation)
        trace('code requested')
        const pending = this.options.mfa.code((expiresAt) => {
          trace('code relay timed out, manual entry offered')
          this.options.status('code-needed', 'Code needed', expiresAt)
        })
        this.options.status('signing-in', 'Signing in')
        const received = await pending
        trace(`code received via ${received.source}`)
        await code.first().fill(received.code)
        submittedMfa = true
        await page
          .getByRole('button', { name: /^(Verify|Continue|Submit|Next)$/i })
          .filter({ visible: true })
          .first()
          .click()
        trace('code submitted')
        this.options.status('signing-in', 'Signing in')
      }
      await page.waitForTimeout(500)
    }
    throw new UserError('CIBC sign-in did not complete. Sign in at cibc.com once, then sync again.')
  }
  private async withDownloadPage<T>(
    work: (page: Page, check: () => void, ready: () => Promise<void>) => Promise<T>,
  ): Promise<T> {
    const generation = ++this.generation
    const events: string[] = []
    const trace: Trace = (event) => {
      events.push(`${new Date().toISOString()} ${event}`)
      this.options.log?.(event)
    }
    let opened: Page | undefined
    trace('run started')
    try {
      const context = await this.open(generation)
      const page = await context.newPage()
      opened = page
      const main = page.mainFrame()
      page.on('framenavigated', (f) => {
        if (f === main) trace(`navigated ${tracedUrl(f.url())}`)
      })
      page.on('response', (r) => {
        if (r.status() >= 400) trace(`${r.status()} ${r.request().method()} ${tracedUrl(r.url())}`)
      })
      page.on('requestfailed', (r) =>
        trace(`failed ${r.method()} ${tracedUrl(r.url())} ${r.failure()?.errorText ?? ''}`),
      )
      await page.goto(downloadUrl, { waitUntil: 'domcontentloaded' })
      await this.signIn(page, generation, trace)
      this.check(generation)
      await this.options.saveSession(JSON.stringify(await context.storageState()))
      const result = await work(
        page,
        () => this.check(generation),
        async () => {
          this.check(generation)
          const renewed = await this.signIn(page, generation, trace)
          this.check(generation)
          if (renewed) await this.options.saveSession(JSON.stringify(await context.storageState()))
        },
      )
      this.check(generation)
      await this.options.saveSession(JSON.stringify(await context.storageState()))
      trace('run finished')
      return result
    } catch (error) {
      trace(`run failed: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
      if (opened && generation === this.generation)
        await this.saveDiagnostics(opened, events, error)
      throw error
    } finally {
      this.options.mfa.cancel()
      await this.browser?.close()
      this.browser = null
      this.check(generation)
    }
  }
  // Overwrites the previous capture. Best effort: a failed capture never hides the real error.
  private async saveDiagnostics(page: Page, events: string[], error: unknown) {
    const folder = this.options.diagnostics
    if (!folder) return
    try {
      await mkdir(folder, { recursive: true, mode: 0o700 })
      const text = await page
        .locator('body')
        .innerText({ timeout: 2000 })
        .catch(() => '')
      const report = [
        `error: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`,
        `url: ${tracedUrl(page.url())}`,
        '',
        ...events,
        '',
        '--- visible text ---',
        text,
      ].join('\n')
      await writeFile(join(folder, 'last-failure.txt'), report, { mode: 0o600 })
      const image = await page.screenshot({ fullPage: true, timeout: 5000 })
      await writeFile(join(folder, 'last-failure.png'), image, { mode: 0o600 })
    } catch {}
  }
  async download(days: number, since?: number): Promise<DownloadedAccount[]> {
    return this.withDownloadPage(async (page, check, ready) => {
      const ranges = downloadRanges(days, since)
      let result: DownloadedAccount[] = []
      for (const [index, range] of ranges.entries()) {
        const batch = await downloadAccounts(page, days, this.options.status, range, {
          historical: index < ranges.length - 1,
          afterReload: ready,
        })
        if (!result.length) result = batch
        else {
          if (
            batch.length !== result.length ||
            batch.some((a) => !result.some((b) => a.id === b.id))
          )
            throw new UserError('CIBC account access changed during the download.')
          result = batch.map((account) => {
            const previous = result.find((a) => a.id === account.id)
            const transactions = new Map(previous?.transactions.map((t) => [t.id, t]))
            for (const transaction of account.transactions) {
              const old = transactions.get(transaction.id)
              if (old && (old.amount !== transaction.amount || old.posted !== transaction.posted))
                throw new UserError('CIBC changed a transaction across exports.')
              transactions.set(transaction.id, transaction)
            }
            return {
              ...account,
              coverageStart: previous?.coverageStart ?? account.coverageStart,
              transactions: [...transactions.values()],
            }
          })
        }
      }
      check()
      return result
    })
  }
  async backfill(): Promise<DownloadedAccount[]> {
    return this.withDownloadPage(async (page, check, ready) => {
      const accounts = await downloadAccounts(page, 60, this.options.status, bankDateRange(60), {
        allAvailable: true,
        afterReload: ready,
      })
      check()
      return accounts
    })
  }
}

// Exported independently so the real bank form can also be exercised in integration tests.
export async function downloadAccounts(
  page: Page,
  days: number,
  status: (phase: SyncPhase, message: string) => void,
  range = bankDateRange(days),
  exportOptions: {
    allAvailable?: boolean
    historical?: boolean
    afterReload?: () => Promise<void>
  } = {},
): Promise<DownloadedAccount[]> {
  const account = page.getByLabel('Account:', { exact: true })
  const software = page.getByLabel('Financial management software:', { exact: true })
  await account.waitFor()
  const options = await account
    .locator('option')
    .evaluateAll((elements) =>
      elements
        .filter((e): e is HTMLOptionElement => e instanceof HTMLOptionElement && Boolean(e.value))
        .map((e) => e.value),
    )
  if (!options.length)
    throw new UserError('CIBC has no downloadable accounts. Cache was not changed.')
  const accounts: DownloadedAccount[] = []
  for (const [index, value] of options.entries()) {
    // CIBC's completed download leaves the form unable to submit another export.
    // Reload before every export, including the first in each historical range.
    await page.reload({ waitUntil: 'domcontentloaded' })
    await exportOptions.afterReload?.()
    status('syncing', `Account ${index + 1} of ${options.length}`)
    await account.waitFor()
    await account.selectOption(value)
    const selectedText = await account.locator('option:checked').innerText()
    await page
      .getByText(exportOptions.allAvailable ? 'All available' : 'All within date range', {
        exact: true,
      })
      .click()
    if (!exportOptions.allAvailable) {
      for (const [prefix, date] of [
        ['From', range.from],
        ['To', range.to],
      ] as const) {
        const [year = '', month = '', day = ''] = date.split('-')
        // Day 1 avoids an invalid date while changing months, such as February 31.
        await page.getByLabel(`${prefix} day`, { exact: true }).selectOption('01')
        await page.getByLabel(`${prefix} year`, { exact: true }).selectOption(year)
        await page.getByLabel(`${prefix} month`, { exact: true }).selectOption(month)
        await page.getByLabel(`${prefix} day`, { exact: true }).selectOption(day)
      }
    }
    await software.selectOption('MONEY')
    const responsePromise = page.waitForResponse(
      (r) =>
        r.url().endsWith('/ebm-ai/api/v1/json/downloadTransactions') &&
        r.request().method() === 'POST',
      { timeout: 45_000 },
    )
    const pendingDownload = waitForDownload(page)
    const downloadPromise = pendingDownload.promise
    void responsePromise.catch(() => undefined)
    // CIBC hides the native submit button. Its accessible ui-button is the real trigger.
    await page.getByRole('button', { name: 'Download Transactions', exact: true }).click()
    const response = await responsePromise
    if (response.status() !== 201) {
      pendingDownload.cancel()
      const empty = z
        .object({ problems: z.array(z.object({ code: z.literal('0121') })).min(1) })
        .safeParse(await response.json())
      // CIBC explicitly returns 422/0121, without a file, when an account has
      // no transactions. This is verified absence, not a missing download.
      if (response.status() === 422 && empty.success) {
        accounts.push(emptyAccount(selectedText, range))
        continue
      }
      throw new UserError('CIBC could not generate an account export. Cache was not changed.')
    }
    const data = z
      .object({
        downloadTransactions: z
          .array(
            z.object({
              accountId: z.string(),
              criteria: z.enum(['DATE_RANGE', 'ALL_AVAILABLE']),
              format: z.literal('MONEY'),
              fileUri: z.string(),
              fromDate: z.string(),
              toDate: z.string(),
            }),
          )
          .length(1),
      })
      .parse(await response.json()).downloadTransactions[0]
    if (
      !data ||
      data.accountId !== value ||
      data.criteria !== (exportOptions.allAvailable ? 'ALL_AVAILABLE' : 'DATE_RANGE') ||
      (!exportOptions.allAvailable &&
        (!data.fromDate.startsWith(range.from) || !data.toDate.startsWith(range.to)))
    )
      throw new UserError('CIBC returned an export for the wrong account or date range.')
    const download = await downloadPromise
    try {
      if (await download.failure()) throw new UserError('CIBC transaction download failed.')
      const stream = await download.createReadStream()
      const chunks: Buffer[] = []
      let size = 0
      for await (const chunk of stream) {
        const buffer = Buffer.from(chunk)
        size += buffer.length
        if (size > 20 * 1024 * 1024) throw new UserError('CIBC export is too large.')
        chunks.push(buffer)
      }
      const parsed = parseOfx(Buffer.concat(chunks))
      const label = selectedText.match(/^(.*?)\s*\(([^)]+)\)/)
      if (
        !label?.[1] ||
        !label[2] ||
        label[2].replace(/\D/g, '') !== parsed.sourceId.replace(/\D/g, '')
      )
        throw new UserError('Downloaded account does not match the CIBC account selector.')
      const selected = emptyAccount(selectedText, range)
      if (
        parsed.currency !== selected.currency ||
        (!exportOptions.historical && parsed.balance !== selected.balance)
      )
        throw new UserError(
          'CIBC export balance does not match the selected account. Cache was not changed.',
        )
      validateExport(
        parsed,
        exportOptions.allAvailable ? { ...range, start: 0 } : range,
        Date.now() / 1000,
        exportOptions.historical,
      )
      const { exportStart: _start, exportEnd: _end, ...record } = parsed
      accounts.push({
        ...record,
        name: label[1].trim(),
        // ALL_AVAILABLE echoes unused form dates. Its OFX metadata and rows
        // identify the actual history returned; never claim coverage before it.
        coverageStart: exportOptions.allAvailable
          ? Math.min(
              Math.floor(parsed.exportStart / 86400) * 86400,
              ...parsed.transactions.map((t) => Math.floor(t.posted / 86400) * 86400),
            )
          : range.start,
        coverageEnd: range.end,
      })
    } finally {
      await download.delete()
    }
  }
  return accounts
}

export function validateExport(
  parsed: ReturnType<typeof parseOfx>,
  range: ReturnType<typeof bankDateRange>,
  now = Date.now() / 1000,
  historical = false,
) {
  // CIBC's DTSTART/DTEND describe the first and last posting days. Live files
  // omit their timezone while DTPOSTED includes [-5:EST], so comparing exact
  // timestamps incorrectly rejects the last day's rows. Keep requested coverage
  // strict, and compare the export's own bounds at calendar-day precision.
  // Historical ledger balances can describe the requested period. They never
  // replace the current cache balance; only a current refresh requires freshness.
  if ((!historical && parsed.balanceDate < now - 86400) || parsed.balanceDate > now + 86400)
    throw new UserError('CIBC returned an old or invalid account balance. Cache was not changed.')
  if (parsed.exportStart > parsed.exportEnd)
    throw new UserError('CIBC export has an invalid date range.')
  const exportStartDay = Math.floor(parsed.exportStart / 86400) * 86400
  const exportEndDay = (Math.floor(parsed.exportEnd / 86400) + 1) * 86400
  for (const transaction of parsed.transactions) {
    if (
      transaction.posted < range.start ||
      transaction.posted >= range.end ||
      transaction.posted < exportStartDay ||
      transaction.posted >= exportEndDay
    )
      throw new UserError('CIBC export transactions do not match the requested date range.')
  }
}

function waitForDownload(page: Page) {
  let timer: ReturnType<typeof setTimeout>
  let rejectDownload: (error: Error) => void = () => {}
  let handler: (download: Download) => void = () => {}
  const onClose = () => {
    cleanup()
    rejectDownload(new UserError('CIBC browser closed.'))
  }
  const cleanup = () => {
    clearTimeout(timer)
    page.off('download', handler)
    page.off('close', onClose)
  }
  const promise = new Promise<Download>((resolve, reject) => {
    rejectDownload = reject
    handler = (download) => {
      cleanup()
      resolve(download)
    }
    page.on('download', handler)
    page.once('close', onClose)
    timer = setTimeout(() => {
      cleanup()
      reject(new UserError('CIBC did not provide the requested download.'))
    }, 60_000)
  })
  void promise.catch(() => undefined)
  return {
    promise,
    cancel: () => {
      cleanup()
      rejectDownload(new UserError('CIBC did not generate a file.'))
    },
  }
}
export function emptyAccount(
  text: string,
  range: ReturnType<typeof bankDateRange>,
  now = Math.floor(Date.now() / 1000),
): DownloadedAccount {
  const match = /^(.*?)\s*\(([^)]+)\)\s+([−-]?(?:US)?\$[\d,]+\.\d{2})$/.exec(text.trim())
  if (!match?.[1] || !match[2] || !match[3])
    throw new UserError('CIBC returned an empty account with an unrecognized balance format.')
  const sourceId = match[2].replace(/\D/g, '')
  if (!/^\d{10,19}$/.test(sourceId))
    throw new UserError('CIBC returned an unrecognized account number.')
  return {
    id: accountId(sourceId),
    sourceId,
    name: match[1],
    currency: match[3].includes('US$') ? 'USD' : 'CAD',
    balance: money(match[3].replace('−', '-').replace(/US|\$|,/g, '')),
    balanceDate: now,
    coverageStart: range.start,
    coverageEnd: range.end,
    transactions: [],
  }
}
export function downloadRanges(days: number, since?: number, now = new Date()) {
  const rolling = bankDateRange(days, now)
  if (since === undefined || since >= rolling.start) return [rolling]
  const start = new Date((since - 3 * 86400) * 1000).toISOString().slice(0, 10)
  const ranges: ReturnType<typeof bankDateRange>[] = []
  let cursor = Date.parse(`${start}T00:00:00Z`) / 1000
  while (cursor < rolling.end - 86400) {
    const next = Math.min(cursor + days * 86400, rolling.end - 86400)
    ranges.push({
      from: new Date(cursor * 1000).toISOString().slice(0, 10),
      to: new Date(next * 1000).toISOString().slice(0, 10),
      start: cursor,
      end: next + 86400,
    })
    cursor = next
  }
  return ranges
}
