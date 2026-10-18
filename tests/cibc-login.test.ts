import { join } from 'node:path'
import { type Browser, chromium } from 'playwright'
import { expect, it, vi } from 'vitest'
import { CibcDownloader } from '../src/main/cibc'
import { CredentialsRejected } from '../src/main/errors'
import { MfaGate } from '../src/main/mfa'
import { sandboxed } from './helpers'

it.skipIf(sandboxed).each(['rolling', 'backfill', 'cancel', 'rejected'] as const)(
  'completes MFA and official %s downloads in one browser, renewing expired sign-in',
  async (mode) => {
    let exports = 0
    let logins = 0
    let launchedBrowser: Browser | undefined
    const launch = chromium.launch.bind(chromium)
    const interceptedLaunch = vi.spyOn(chromium, 'launch').mockImplementation(async (options) => {
      const browser = await launch(options)
      launchedBrowser = browser
      const newContext = browser.newContext.bind(browser)
      browser.newContext = async (options) => {
        const context = await newContext(options)
        let authenticated = false
        // Every bank request is intercepted. No credentials or codes leave this fixture.
        await context.route('**/*', async (route) => {
          if (route.request().url().endsWith('/fixture-authenticated')) {
            logins++
            authenticated = true
            await route.fulfill({ status: 204 })
            return
          }
          if (route.request().url().endsWith('/ebm-ai/api/v1/json/downloadTransactions')) {
            exports++
            if (mode === 'backfill' && exports === 1) authenticated = false
            await route.fulfill({ status: 422, json: { problems: [{ code: '0121' }] } })
            return
          }
          const fields = ['From', 'To']
            .flatMap((prefix) =>
              [
                ['day', Array.from({ length: 31 }, (_, i) => String(i + 1).padStart(2, '0'))],
                ['month', Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2, '0'))],
                ['year', [String(new Date().getFullYear() - 1), String(new Date().getFullYear())]],
              ].map(
                ([part, values]) =>
                  `<select aria-label="${prefix} ${part}">${(values as string[]).map((v) => `<option value="${v}">${v}</option>`).join('')}</select>`,
              ),
            )
            .join('')
          const downloadForm = `<main><label for="account">Account:</label><select id="account"><option value="bank-1">Chequing (12345-12-34567) $1,200.25</option><option value="bank-2">Savings (12345-12-34568) $1,200.25</option></select><label for="software">Financial management software:</label><select id="software"><option value="MONEY">Microsoft Money</option></select><label><input type="radio" name="criteria" value="DATE_RANGE">All within date range</label><label><input type="radio" name="criteria" value="ALL_AVAILABLE">All available</label>${fields}<button onclick="fetch('/ebm-ai/api/v1/json/downloadTransactions',{method:'POST'})">Download Transactions</button></main>`
          await route.fulfill({
            contentType: 'text/html',
            body: authenticated
              ? downloadForm
              : `<main><input aria-label="Card number"><button onclick="password()">Continue</button></main><script>
            const main=document.querySelector('main');
            function password(){main.innerHTML='<input type="password"><button onclick="verification()">Sign on</button>'}
            function verification(){main.innerHTML=${JSON.stringify(mode === 'rejected' ? '<p>Your password is incorrect.</p>' : '<input aria-label="Enter the 6-digit verification code"><button onclick="finish()">Continue</button>')}}
            async function finish(){if(main.querySelector('input').value==='314159'){await fetch('/fixture-authenticated',{method:'POST'});document.body.innerHTML=${JSON.stringify(downloadForm)}}}
          </script>`,
          })
        })
        return context
      }
      return browser
    })
    const mfa = new MfaGate()
    const phases: string[] = []
    let downloader: CibcDownloader
    const saveSession = vi.fn(async () => {
      if (mode === 'cancel' && saveSession.mock.calls.length === 2) void downloader.cancel()
    })
    try {
      downloader = new CibcDownloader({
        browserRoot: join(process.cwd(), 'node_modules/.cache/ms-playwright'),
        credentials: async () => ({ card: 'fixture-card', password: 'fixture-password' }),
        session: async () => undefined,
        saveSession,
        mfa,
        status: (phase) => {
          phases.push(phase)
          if (phase === 'signing-in' && mfa.active) mfa.submit('314159')
        },
      })
      if (mode === 'rejected') {
        await expect(downloader.download(60)).rejects.toBeInstanceOf(CredentialsRejected)
        expect(exports).toBe(0)
        expect(saveSession).not.toHaveBeenCalled()
        return
      }
      if (mode === 'cancel') await expect(downloader.backfill()).rejects.toThrow('cancelled')
      else {
        const accounts =
          mode === 'rolling' ? await downloader.download(30) : await downloader.backfill()
        expect(accounts).toHaveLength(2)
        expect(accounts.every((a) => a.transactions.length === 0)).toBe(true)
      }
      expect(phases).toContain('signing-in')
      expect(interceptedLaunch).toHaveBeenCalledTimes(1)
      expect(logins).toBe(mode === 'backfill' ? 2 : 1)
      expect(exports).toBe(2)
      expect(saveSession).toHaveBeenCalledTimes(mode === 'backfill' ? 3 : 2)
      expect(mfa.active).toBe(false)
      expect(launchedBrowser?.isConnected()).toBe(false)
    } finally {
      interceptedLaunch.mockRestore()
    }
  },
  30_000,
)
