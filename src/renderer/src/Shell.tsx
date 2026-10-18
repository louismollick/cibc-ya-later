import { LoaderCircle, RefreshCw } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import type { AppState } from '../../shared/types'
import { Accounts } from './Accounts'
import { Apps } from './Apps'
import { countdown, upcoming, when } from './lib/format'
import { useAction, useNow } from './lib/hooks'
import { Settings } from './Settings'

type Pane = 'accounts' | 'apps' | 'settings'

// Sidebar layout. Sync status is pinned to the bottom of the sidebar so it is
// visible from every pane; banners that need action sit above every pane.
export function Shell({ state }: { state: AppState }) {
  const [pane, setPane] = useState<Pane>('accounts')
  const item = (id: Pane, label: string, count?: number) => (
    <button
      type="button"
      aria-current={pane === id ? 'page' : undefined}
      onClick={() => setPane(id)}
    >
      {label}
      {count !== undefined && <em>{count}</em>}
    </button>
  )
  return (
    <div className="shell">
      <aside>
        <nav>
          {item('accounts', 'Accounts', state.accounts.length)}
          {item('apps', 'Apps', state.apps.length)}
          {item('settings', 'Settings')}
        </nav>
        <Status state={state} />
      </aside>
      <main>
        <Banners state={state} />
        {pane === 'accounts' && <Accounts state={state} />}
        {pane === 'apps' && <Apps state={state} />}
        {pane === 'settings' && <Settings state={state} />}
      </main>
    </div>
  )
}

export function isBusy(state: AppState) {
  return ['signing-in', 'syncing', 'code-needed'].includes(state.sync.phase)
}

// Pane title row. It doubles as the window's drag area.
export function PaneHead({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <header className="pane-head">
      <h1>{title}</h1>
      {children}
    </header>
  )
}

export function Banner({
  tone = 'bad',
  children,
  action,
}: {
  tone?: 'bad' | 'warn'
  children: ReactNode
  action?: ReactNode
}) {
  return (
    <div className={cn('banner', tone)}>
      <span>{children}</span>
      {action && <div className="banner-action">{action}</div>}
    </div>
  )
}

function Status({ state }: { state: AppState }) {
  const { sync } = state
  const { run } = useAction()
  const busy = isBusy(state)
  const label = {
    idle: sync.lastSuccess ? `Synced ${when(sync.lastSuccess)}` : 'Not synced',
    'signing-in': 'Signing in',
    syncing: 'Syncing',
    'code-needed': 'Code needed',
    error: 'Sync failed',
  }[sync.phase]
  const detail = busy && sync.message && sync.message !== label ? sync.message : ''
  return (
    <div className="status">
      <div
        className="status-line"
        title={sync.nextAttempt ? `Next sync ${upcoming(sync.nextAttempt)}` : undefined}
      >
        {sync.phase === 'signing-in' || sync.phase === 'syncing' ? (
          <LoaderCircle className="spin" />
        ) : (
          <span
            className={cn(
              'dot',
              sync.phase === 'error' && 'bad',
              sync.phase === 'code-needed' && 'warn',
              sync.phase === 'idle' && !sync.lastSuccess && 'off',
            )}
          />
        )}
        {label}
      </div>
      {detail && <div className="status-detail">{detail}</div>}
      {busy ? (
        <Button variant="outline" size="sm" onClick={() => void run(window.cibc.cancelSync)}>
          Cancel
        </Button>
      ) : (
        <Button size="sm" onClick={() => void run(window.cibc.sync)}>
          <RefreshCw />
          Sync
        </Button>
      )}
    </div>
  )
}

// Everything that needs the owner's action, shown above whichever pane is open.
function Banners({ state }: { state: AppState }) {
  const { sync, blocker } = state
  const { busy, error, run } = useAction()
  return (
    <>
      {state.api.error && <Banner>{state.api.error}</Banner>}
      {sync.phase === 'code-needed' && sync.codeExpiresAt && (
        <CodeBanner expiresAt={sync.codeExpiresAt} />
      )}
      {blocker?.kind === 'missing-account' && (
        <Banner
          action={
            <Button
              size="sm"
              disabled={busy || isBusy(state)}
              onClick={() => void run(() => window.cibc.closeAccount(blocker.accountId))}
            >
              Mark closed
            </Button>
          }
        >
          {blocker.name} is no longer at CIBC.
        </Banner>
      )}
      {blocker?.kind === 'history-gap' && (
        <Banner
          action={
            <Button
              size="sm"
              disabled={busy || isBusy(state)}
              onClick={() => void run(window.cibc.downloadFullHistory)}
            >
              Download full history
            </Button>
          }
        >
          History has a gap.
        </Banner>
      )}
      {sync.phase === 'error' && !blocker && <Banner>{sync.message}</Banner>}
      {error && <Banner>{error}</Banner>}
    </>
  )
}

// Code fallback, shown only after the iPhone relay missed its window.
function CodeBanner({ expiresAt }: { expiresAt: number }) {
  const [code, setCode] = useState('')
  const { busy, error, run } = useAction()
  const now = useNow()
  return (
    <Banner
      tone="warn"
      action={
        <form
          onSubmit={(e) => {
            e.preventDefault()
            void run(() => window.cibc.submitCode(code))
            setCode('')
          }}
        >
          <span className="countdown">{countdown(expiresAt - now)}</span>
          <Input
            className="code"
            aria-label="Verification code"
            autoComplete="one-time-code"
            inputMode="numeric"
            autoFocus
            maxLength={8}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
          />
          <Button size="sm" disabled={busy || code.length < 6}>
            Verify
          </Button>
        </form>
      }
    >
      {error || "iPhone didn't send the code."}
    </Banner>
  )
}
