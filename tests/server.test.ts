import { request, type Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MfaGate } from '../src/main/mfa'
import { listen, mfaServer, simplefinServer } from '../src/main/server'
import { Store } from '../src/main/store'
import { accountQuery, validBaseUrl } from '../src/main/validation'
import { sampleAccount } from './helpers'

let store: Store
const servers: Server[] = []
const base = 'https://bank.tailnet.ts.net/simplefin'
beforeEach(() => {
  store = new Store(':memory:')
  store.set('baseUrl', base)
})
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  store.close()
})
async function start(server: Server) {
  servers.push(server)
  await listen(server, 0)
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No address')
  return `http://127.0.0.1:${address.port}`
}
const headers = { host: '127.0.0.1:0' }
function auth() {
  const token = store.createToken('Actual', base)
  const claim = new URL(Buffer.from(token, 'base64').toString()).pathname.split('/').at(-1) ?? ''
  const url = new URL(store.claim(claim, base) ?? '')
  return `Basic ${Buffer.from(`${url.username}:${url.password}`).toString('base64')}`
}
describe('SimpleFIN HTTP', () => {
  it('implements info, protected token creation guidance, claim once, Basic auth and filters', async () => {
    store.saveSnapshot([sampleAccount(), sampleAccount('second')], 2)
    const sync = {
      status: {
        phase: 'idle' as const,
        message: '',
        lastSuccess: store.lastSuccess(),
        codeExpiresAt: null,
        nextAttempt: null,
      },
    }
    const url = await start(simplefinServer(store, sync, 0))
    expect(await (await fetch(`${url}/simplefin/info`, { headers })).json()).toEqual({
      versions: ['1.0'],
    })
    expect((await fetch(`${url}/simplefin/create`, { headers })).status).toBe(200)
    expect((await fetch(`${url}/simplefin/accounts`, { headers })).status).toBe(403)
    const authorization = auth()
    const response = await fetch(
      `${url}/simplefin/accounts?account=account-a&start-date=1791763200&end-date=1791849600`,
      { headers: { ...headers, authorization } },
    )
    const result = await response.json()
    expect(response.status).toBe(200)
    expect(result.accounts).toHaveLength(1)
    expect(result.accounts[0].transactions).toHaveLength(1)
    expect(result.accounts[0].org['sfin-url']).toBe(base)
    expect(
      (
        await fetch(`${url}/simplefin/accounts?start-date=no`, {
          headers: { ...headers, authorization },
        })
      ).status,
    ).toBe(400)
    const token = store.createToken('Sure', base),
      claim = new URL(Buffer.from(token, 'base64').toString()).pathname
    const first = await fetch(`${url}${claim}`, { method: 'POST', headers })
    expect(first.status).toBe(200)
    expect(first.headers.get('content-type')).toContain('text/plain')
    expect((await fetch(`${url}${claim}`, { method: 'POST', headers })).status).toBe(403)
  })
  it('serves cached snapshots during sync and rejects browser-origin requests and foreign Host headers', async () => {
    store.saveSnapshot([sampleAccount()], 1)
    const sync = {
      status: {
        phase: 'syncing' as const,
        message: '',
        lastSuccess: store.lastSuccess(),
        codeExpiresAt: null,
        nextAttempt: null,
      },
    }
    const url = await start(simplefinServer(store, sync, 0)),
      authorization = auth()
    const result = await (
      await fetch(`${url}/simplefin/accounts`, { headers: { ...headers, authorization } })
    ).json()
    expect(result.errors).toEqual([])
    expect(
      (
        await fetch(`${url}/simplefin/accounts`, {
          headers: { ...headers, authorization, origin: 'https://evil.example' },
        })
      ).status,
    ).toBe(403)
    expect(
      await new Promise<number>((resolve) => {
        const req = request(
          `${url}/simplefin/info`,
          { headers: { host: 'evil.example' } },
          (res) => {
            res.resume()
            resolve(res.statusCode ?? 0)
          },
        )
        req.end()
      }),
    ).toBe(403)
  })
  it.each(['idle', 'syncing', 'code-needed', 'error'] as const)(
    'reads only sync status and warns only on failure while %s',
    async (phase) => {
      store.saveSnapshot([sampleAccount()], 1, 1792108800)
      const url = await start(
        simplefinServer(
          store,
          {
            status: {
              phase,
              message: '',
              lastSuccess: 1792108800,
              codeExpiresAt: null,
              nextAttempt: null,
            },
          },
          0,
        ),
      )
      const response = await fetch(`${url}/simplefin/accounts`, {
        headers: { ...headers, authorization: auth() },
      })
      expect(response.status).toBe(200)
      expect((await response.json()).errors).toEqual(
        phase === 'error'
          ? [
              'Serving the CIBC download from 2026-10-16T00:00:00.000Z. The last sync on the Mac failed.',
            ]
          : [],
      )
    },
  )
  it('returns an explicit unavailable response before the first verified download', async () => {
    const sync = {
      status: {
        phase: 'error' as const,
        message: '',
        lastSuccess: null,
        codeExpiresAt: null,
        nextAttempt: null,
      },
    }
    const url = await start(simplefinServer(store, sync, 0))
    expect(
      (await fetch(`${url}/simplefin/accounts`, { headers: { ...headers, authorization: auth() } }))
        .status,
    ).toBe(503)
  })
})
describe('MFA HTTP and lifecycle', () => {
  it('accepts one code only during the active challenge on its separate listener', async () => {
    const gate = new MfaGate(),
      log = vi.fn(),
      url = await start(mfaServer(gate, () => base, log, 0))
    const post = (code = '123456', identity = 'iphone@example.com') =>
      fetch(`${url}/internal/mfa/code`, {
        method: 'POST',
        headers: {
          ...headers,
          'tailscale-user-login': identity,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ code }),
      })
    expect((await post()).status).toBe(409)
    const waiting = gate.wait()
    expect((await post('123456', '')).status).toBe(403)
    expect((await post('bad')).status).toBe(400)
    expect((await post()).status).toBe(204)
    expect(await waiting).toEqual({ code: '123456', source: 'relay' })
    expect((await post()).status).toBe(409)
    expect(log.mock.calls.map(([line]) => line.split(' ')[3])).toEqual([
      '409',
      '403',
      '400',
      '204',
      '409',
    ])
    expect(log.mock.calls.flat().join('\n')).not.toContain('123456')
  })
  it('expires and cancels challenges without retaining a code', async () => {
    const gate = new MfaGate(),
      expired = gate.wait(5)
    await expect(expired).rejects.toThrow('timed out')
    expect(gate.active).toBe(false)
    const next = gate.wait()
    gate.cancel()
    await expect(next).rejects.toThrow('cancelled')
    expect(() => gate.submit('123456', 'manual')).toThrow('No CIBC')
  })
  it('requires Serve identity and rejects Funnel, browser origins and foreign hosts', async () => {
    const gate = new MfaGate(),
      url = await start(mfaServer(gate, () => base, undefined, 0))
    const post = (extra: Record<string, string>) =>
      new Promise<number>((resolve, reject) => {
        const req = request(
          `${url}/internal/mfa/code`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...extra },
          },
          (res) => {
            res.resume()
            resolve(res.statusCode ?? 0)
          },
        )
        req.on('error', reject)
        req.end(JSON.stringify({ code: '00123456' }))
      })
    const identity = { 'tailscale-user-login': 'iphone@example.com' }
    const waiting = gate.wait()
    for (const extra of [
      {},
      { ...identity, 'tailscale-funnel-request': 'true' },
      { ...identity, origin: 'https://untrusted.example' },
      { ...identity, host: 'untrusted.example' },
    ])
      expect(await post(extra)).toBe(403)
    expect(gate.active).toBe(true)
    expect(await post({ ...identity, host: 'bank.tailnet.ts.net:8443' })).toBe(204)
    expect(await waiting).toEqual({ code: '00123456', source: 'relay' })
  })
})
describe('Input constraints', () => {
  it('requires a private Tailscale HTTPS base URL', () => {
    expect(validBaseUrl(base)).toBe(true)
    for (const value of [
      'http://bank.tailnet.ts.net/simplefin',
      'https://example.com/simplefin',
      'https://user:pass@bank.tailnet.ts.net/simplefin',
      'https://bank.tailnet.ts.net/simplefin?x=1',
    ])
      expect(validBaseUrl(value)).toBe(false)
  })
  it('rejects ambiguous and malformed date queries', () => {
    for (const query of [
      'start-date=2&start-date=3',
      'start-date=-1',
      'start-date=10&end-date=9',
      'pending=yes',
      'balances-only=1&balances-only=0',
    ])
      expect(() => accountQuery(new URLSearchParams(query))).toThrow()
  })
})
it('does not allow a code from an expired login to resolve a newer challenge', async () => {
  const gate = new MfaGate(),
    first = gate.wait(),
    old = gate.challenge
  gate.cancel()
  await expect(first).rejects.toThrow()
  const second = gate.wait()
  expect(() => gate.submit('123456', 'manual', old)).toThrow('changed')
  gate.submit('654321', 'manual')
  expect(await second).toEqual({ code: '654321', source: 'manual' })
})
it('rejects authenticated requests marked as public Tailscale Funnel traffic', async () => {
  store.saveSnapshot([sampleAccount()], 1)
  const url = await start(
    simplefinServer(
      store,
      {
        status: {
          phase: 'idle',
          message: '',
          lastSuccess: store.lastSuccess(),
          codeExpiresAt: null,
          nextAttempt: null,
        },
      },
      0,
    ),
  )
  expect(
    (
      await fetch(`${url}/simplefin/accounts`, {
        headers: { authorization: auth(), 'tailscale-funnel-request': 'true' },
      })
    ).status,
  ).toBe(403)
})
