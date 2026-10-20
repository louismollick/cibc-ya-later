import { createServer } from 'node:http'
import { join } from 'node:path'
import { chromium } from 'patchright'
import { expect, it, vi } from 'vitest'
import { bankDateRange, browserExecutable, downloadAccounts } from '../src/main/cibc'
import { ofx, sandboxed } from './helpers'

it.skipIf(sandboxed).each(['rolling', 'historical', 'all available'])(
  'downloads every account and verifies export identity (%s)',
  async (mode) => {
    const historical = mode === 'historical'
    const allAvailable = mode === 'all available'
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-16T07:00:00Z'))
    const names = ['Chequing', 'Savings', 'Work', 'Visa']
    let pageLoads = 0
    const requests: {
      accountId: string
      criteria: string
      format: string
      fromDate: string
      toDate: string
    }[] = []
    const server = createServer(async (req, res) => {
      if (req.url === '/') {
        pageLoads++
        res.setHeader('Content-Type', 'text/html; charset=utf-8')
        const fields = ['From', 'To']
          .flatMap((prefix) =>
            [
              ['day', ['01', '10', '16', '17', '18', '19', '20', '21']],
              ['month', ['08', '09', '10']],
              ['year', ['2026']],
            ].map(
              ([part, values]) =>
                `<select aria-label="${prefix} ${part}">${(values as string[]).map((v) => `<option value="${v}">${v}</option>`).join('')}</select>`,
            ),
          )
          .join('')
        res.end(`<label for="account">Account:</label><select id="account"><option value="">Choose</option>${names.map((name, i) => `<option value="bank-${i}">${name} (12345 12-3456${i}) ${i === 3 ? '−' : ''}$1,200.25</option>`).join('')}</select><label><input type="radio" name="criteria" value="DATE_RANGE">All within date range</label><label><input type="radio" name="criteria" value="ALL_AVAILABLE">All available</label>${fields}<label for="software">Financial management software:</label><select id="software"><option value="MONEY">Microsoft Money</option></select><div role="button" tabindex="0" id="download">Download Transactions</div><script>
   let submitted=false;
   document.querySelector('#download').onclick=async()=>{
    if(submitted)return;submitted=true;
    const val=(prefix,part)=>document.querySelector('select[aria-label="'+prefix+' '+part+'"]').value;
    const date=prefix=>['year','month','day'].map(part=>val(prefix,part)).join('-');
    const data={downloadTransaction:{accountId:document.querySelector('#account').value,criteria:document.querySelector('input[name=criteria]:checked').value,format:document.querySelector('#software').value,fromDate:date('From'),toDate:date('To')}};
    const response=await fetch('/ebm-ai/api/v1/json/downloadTransactions',{method:'POST',body:JSON.stringify(data)});const json=await response.json();const a=document.createElement('a');a.href='/file/'+json.downloadTransactions[0].accountId;a.download='cibc.ofx';a.click();
   };</script>`)
        return
      }
      if (req.url === '/ebm-ai/api/v1/json/downloadTransactions') {
        let body = ''
        for await (const chunk of req) body += chunk
        const { downloadTransaction } = JSON.parse(body)
        requests.push(downloadTransaction)
        if (downloadTransaction.accountId === 'bank-1') {
          res.writeHead(422, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ problems: [{ code: '0121' }] }))
          return
        }
        res.writeHead(201, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            downloadTransactions: [{ ...downloadTransaction, fileUri: 'fixture' }],
          }),
        )
        return
      }
      const index = Number(req.url?.at(-1))
      const content = ofx({ credit: index === 3 })
        .toString()
        .replace('12345 12-34567', `12345 12-3456${index}`)
        .replaceAll('abc-', `bank${index}-`)
        .replace(
          '20261016120000[-4:EDT]',
          historical ? '20261012120000[-4:EDT]' : '20261016120000[-4:EDT]',
        )
        .replace('<BALAMT>1200.25', historical ? '<BALAMT>123.45' : '<BALAMT>1200.25')
        .replace(/202610(01|10|11|15)/g, (date) =>
          allAvailable ? date.replace('2026', '2019') : date,
        )
      res.writeHead(200, {
        'Content-Type': 'application/x-ofx',
        'Content-Disposition': 'attachment; filename="cibc.ofx"',
      })
      res.end(content)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('No address')
    const browser = await chromium.launch({
      executablePath: browserExecutable(join(process.cwd(), 'node_modules/.cache/ms-playwright')),
      headless: true,
      chromiumSandbox: true,
    })
    try {
      const page = await browser.newPage({ acceptDownloads: true })
      await page.goto(`http://127.0.0.1:${address.port}`)
      const accounts = await downloadAccounts(page, 60, () => {}, undefined, {
        historical,
        allAvailable,
      })
      expect(accounts.map((a) => a.name)).toEqual(names)
      expect(pageLoads).toBe(names.length + 1)
      expect(new Set(accounts.map((a) => a.id)).size).toBe(4)
      expect(requests.map((r) => r.accountId)).toEqual(names.map((_, i) => `bank-${i}`))
      expect(
        requests.every(
          (r) =>
            r.criteria === (allAvailable ? 'ALL_AVAILABLE' : 'DATE_RANGE') &&
            r.format === 'MONEY' &&
            (allAvailable || r.fromDate === bankDateRange(60).from),
        ),
      ).toBe(true)
      if (allAvailable)
        expect(accounts[0]?.coverageStart).toBe(Date.parse('2019-10-01T00:00:00Z') / 1000)
      const nextBatch = await downloadAccounts(page, 30, () => {}, undefined, {
        historical,
        allAvailable,
      })
      expect(nextBatch.map((a) => a.id)).toEqual(accounts.map((a) => a.id))
      expect(pageLoads).toBe(names.length * 2 + 1)
      expect(requests).toHaveLength(names.length * 2)
    } finally {
      vi.useRealTimers()
      await browser.close()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  },
  30000,
)
