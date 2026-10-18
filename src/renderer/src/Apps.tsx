import { Copy, Plus } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { AppState, ConnectedApp } from '../../shared/types'
import { ago, countdown } from './lib/format'
import { useAction, useNow } from './lib/hooks'
import { Banner, PaneHead } from './Shell'

// Budgeting apps with read-only access through the SimpleFIN-compatible API. Connect creates a one-time
// setup token that the app claims within 15 minutes.
export function Apps({ state }: { state: AppState }) {
  const [naming, setNaming] = useState(false)
  const [label, setLabel] = useState('Sure')
  const [token, setToken] = useState('')
  const { busy, error, run } = useAction()
  const now = useNow()
  const ready = Boolean(state.simplefinUrl) && state.api.running
  useEffect(() => {
    if (!token) return
    const timer = setTimeout(() => setToken(''), 900_000)
    return () => clearTimeout(timer)
  }, [token])
  return (
    <>
      <PaneHead title="Apps">
        {!naming && !token && (
          <Button variant="outline" size="sm" disabled={!ready} onClick={() => setNaming(true)}>
            <Plus />
            Connect
          </Button>
        )}
      </PaneHead>
      {error && <Banner>{error}</Banner>}
      {naming && (
        <form
          className="inline"
          onSubmit={(e) => {
            e.preventDefault()
            void run(async () => {
              setToken(await window.cibc.connectApp(label))
              setNaming(false)
            })
          }}
        >
          <Input
            aria-label="App name"
            autoFocus
            maxLength={60}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
          <Button size="sm" disabled={busy || !label.trim()}>
            Connect
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => setNaming(false)}>
            Cancel
          </Button>
        </form>
      )}
      {token && (
        <div className="token">
          <code>{token}</code>
          <div>
            <Button size="sm" onClick={() => void run(() => window.cibc.copy(token))}>
              <Copy />
              Copy
            </Button>
            <Button variant="outline" size="sm" onClick={() => setToken('')}>
              Done
            </Button>
          </div>
        </div>
      )}
      <ul className="rows">
        {state.apps.map((app) => (
          <li key={app.id}>
            <div>
              {app.label}
              <small>{appStatus(app, now)}</small>
            </div>
            <Button
              variant="link"
              size="sm"
              className="quiet"
              disabled={busy}
              onClick={() => void run(() => window.cibc.revokeApp(app.id))}
            >
              Revoke
            </Button>
          </li>
        ))}
      </ul>
      <footer className="pane-foot">
        {state.simplefinUrl ? (
          <>
            <span>URL</span>
            <code>{state.simplefinUrl}</code>
          </>
        ) : (
          <span>{state.tailscaleError ?? "Tailscale Serve isn't ready."}</span>
        )}
      </footer>
    </>
  )
}

function appStatus(app: ConnectedApp, now: number) {
  if (app.claimed) return app.lastUsed ? `fetched ${ago(app.lastUsed, now)}` : 'never fetched'
  const left = (app.expiresAt ?? 0) - now
  return left > 0 ? `expires in ${countdown(left)}` : 'expired'
}
