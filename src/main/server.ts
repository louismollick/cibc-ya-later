import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Log } from './log'
import type { MfaGate } from './mfa'
import type { Store } from './store'
import type { SyncService } from './sync'
import { accountQuery, validBaseUrl } from './validation'

function send(
  res: ServerResponse,
  status: number,
  body: string | object,
  type = 'application/json',
) {
  res.writeHead(status, {
    'Content-Type': `${type}; charset=utf-8`,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy':
      "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
  })
  res.end(typeof body === 'string' ? body : JSON.stringify(body))
}
function trustedRequest(req: IncomingMessage, baseUrl: string, port: number, mfa: boolean) {
  if (
    req.headers.origin ||
    req.headers['sec-fetch-site'] === 'cross-site' ||
    req.headers['tailscale-funnel-request']
  )
    return false
  const allowed = new Set([
    `127.0.0.1:${req.socket.localPort ?? port}`,
    `localhost:${req.socket.localPort ?? port}`,
  ])
  if (validBaseUrl(baseUrl)) {
    const u = new URL(baseUrl)
    allowed.add(mfa ? `${u.hostname}:8443` : u.host)
  }
  return allowed.has(req.headers.host ?? '')
}
function basic(req: IncomingMessage): [string, string] | null {
  const match = /^Basic ([A-Za-z0-9+/]+=*)$/i.exec(req.headers.authorization ?? '')
  if (!match?.[1] || match[1].length > 2048) return null
  const decoded = Buffer.from(match[1], 'base64').toString('utf8'),
    colon = decoded.indexOf(':')
  return colon > 0 ? [decoded.slice(0, colon), decoded.slice(colon + 1)] : null
}
async function body(req: IncomingMessage) {
  let result = ''
  for await (const chunk of req) {
    result += chunk.toString()
    if (Buffer.byteLength(result) > 256) throw new Error('Request too large.')
  }
  return JSON.parse(result) as unknown
}
export function simplefinServer(store: Store, sync: Pick<SyncService, 'status'>, port = 3610) {
  return createServer(async (req, res) => {
    try {
      const baseUrl = store.get('baseUrl') ?? ''
      if (!trustedRequest(req, baseUrl, port, false)) {
        send(res, 403, 'Forbidden', 'text/plain')
        return
      }
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (req.method === 'GET' && url.pathname === '/simplefin/info') {
        send(res, 200, { versions: ['1.0'] })
        return
      }
      if (req.method === 'GET' && url.pathname === '/simplefin/create') {
        send(
          res,
          200,
          '<!doctype html><html lang="en"><meta charset="utf-8"><title>Connect CIBC Ya Later</title><style>body{background:#000;color:white;font:16px system-ui;max-width:38rem;margin:5rem auto;padding:2rem}h1{font-size:24px}</style><h1>Connect CIBC Ya Later</h1><p>Open CIBC Ya Later from the Mac menu bar. Under Clients, enter the application name and choose Generate setup token. Paste that token into Actual Budget or Sure within 15 minutes.</p><p>Only the Mac owner can create access. Each application gets its own read-only credential.</p></html>',
          'text/html',
        )
        return
      }
      const claim = /^\/simplefin\/claim\/([A-Za-z0-9_-]{1,128})$/.exec(url.pathname)
      if (req.method === 'POST' && claim?.[1]) {
        if (!validBaseUrl(baseUrl)) {
          send(res, 503, 'Configure Tailscale HTTPS in CIBC Ya Later first.', 'text/plain')
          return
        }
        const access = store.claim(claim[1], baseUrl)
        send(
          res,
          access ? 200 : 403,
          access ?? 'Invalid, expired, or already claimed token.',
          'text/plain',
        )
        return
      }
      if (req.method === 'GET' && url.pathname === '/simplefin/accounts') {
        const auth = basic(req)
        if (!auth || !store.authenticate(...auth)) {
          send(res, 403, 'Invalid credentials.', 'text/plain')
          return
        }
        let query: ReturnType<typeof accountQuery>
        try {
          query = accountQuery(url.searchParams)
        } catch {
          send(res, 400, { errors: ['Invalid account query.'], accounts: [] })
          return
        }
        const success = store.lastSuccess()
        if (!success) {
          send(res, 503, {
            errors: [
              'No verified CIBC download is available. Complete a sync on the Mac, then try again.',
            ],
            accounts: [],
          })
          return
        }
        const errors: string[] = []
        if (sync.status.phase === 'error')
          errors.push(
            `Serving the CIBC download from ${new Date(success * 1000).toISOString()}. The last sync on the Mac failed.`,
          )
        if (
          !query.balancesOnly &&
          query.start !== undefined &&
          store
            .coverage()
            .some(
              (a) =>
                (!query.accounts.length || query.accounts.includes(a.id)) &&
                (query.start ?? 0) < a.coverageStart,
            )
        )
          errors.push(
            'Requested history starts before the locally downloaded date range. Earlier transactions are not available.',
          )
        res.setHeader('X-CIBC-Last-Success', String(success))
        send(res, 200, { errors, accounts: store.accountSet(baseUrl, query) })
        return
      }
      send(res, 404, 'Not found', 'text/plain')
    } catch {
      if (!res.headersSent)
        send(res, 500, 'Request failed. See CIBC Ya Later on the Mac.', 'text/plain')
      else res.end()
    }
  })
}
// Logs each request's outcome so relay deliveries can be checked afterwards. Never logs the code.
export function mfaServer(
  gate: MfaGate,
  getBaseUrl: () => string,
  log: Log = () => {},
  port = 3611,
) {
  let requests = 0,
    resetAt = Date.now() + 60_000
  return createServer(async (req, res) => {
    const reply = (status: number, text: string, body = text) => {
      log(`code relay request: ${status} ${text}`)
      send(res, status, body, 'text/plain')
    }
    try {
      // Serve strips spoofed identity headers, then sets these for authenticated
      // tailnet users. The loopback listener must never be exposed directly.
      if (!trustedRequest(req, getBaseUrl(), port, true) || !req.headers['tailscale-user-login']) {
        reply(403, 'Forbidden')
        return
      }
      if (req.method !== 'POST' || req.url !== '/internal/mfa/code') {
        reply(404, 'Not found')
        return
      }
      if (Date.now() > resetAt) {
        requests = 0
        resetAt = Date.now() + 60_000
      }
      if (++requests > 10) {
        reply(429, 'Too many attempts.')
        return
      }
      const challenge = gate.challenge
      if (challenge === null) {
        reply(409, 'No CIBC login is awaiting MFA.')
        return
      }
      if (!(req.headers['content-type'] ?? '').startsWith('application/json')) {
        reply(415, 'Use application/json.')
        return
      }
      try {
        const input = await body(req)
        if (
          typeof input !== 'object' ||
          input === null ||
          !('code' in input) ||
          typeof input.code !== 'string' ||
          Object.keys(input).length !== 1
        )
          throw new Error('Invalid code.')
        gate.submit(input.code, 'relay', challenge)
      } catch {
        reply(400, 'Invalid or expired verification code.')
        return
      }
      reply(204, 'Code accepted.', '')
    } catch {
      reply(500, 'MFA request failed.')
    }
  })
}
export async function listen(server: Server, port: number) {
  server.requestTimeout = 10_000
  server.headersTimeout = 10_000
  server.keepAliveTimeout = 5000
  server.maxHeadersCount = 32
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
}
