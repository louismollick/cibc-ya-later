import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { AppState } from '../../shared/types'
import { useAction } from './lib/hooks'

// One-time sign-in. The full history checkbox only shows until a full history
// download has completed, so signing out and back in doesn't offer it again.
export function SignIn({ state }: { state: AppState }) {
  const [card, setCard] = useState('')
  const [password, setPassword] = useState('')
  const [fullHistory, setFullHistory] = useState(true)
  const { busy, error, run } = useAction()
  const offerHistory = state.fullHistory.completedAt === null
  const message = error || (state.credentials === 'rejected' ? 'CIBC rejected the password.' : '')
  return (
    <main className="signin">
      <div className="titlebar" />
      <form
        onSubmit={(e) => {
          e.preventDefault()
          const values = [card, password] as const
          setPassword('')
          void run(() => window.cibc.signIn(values[0], values[1], offerHistory && fullHistory))
        }}
      >
        <h1>Sign in to CIBC</h1>
        {message && <p className="error">{message}</p>}
        <div>
          <label htmlFor="card">Card number</label>
          <Input
            id="card"
            type="password"
            inputMode="numeric"
            autoComplete="off"
            autoFocus
            maxLength={19}
            value={card}
            onChange={(e) => setCard(e.target.value.replace(/\D/g, ''))}
          />
        </div>
        <div>
          <label htmlFor="password">Password</label>
          <Input
            id="password"
            type="password"
            autoComplete="current-password"
            maxLength={256}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        {offerHistory && (
          <label className="check">
            <input
              type="checkbox"
              checked={fullHistory}
              onChange={(e) => setFullHistory(e.target.checked)}
            />
            Download full transaction history
          </label>
        )}
        <Button disabled={busy || card.length < 6 || !password}>Sign in</Button>
      </form>
    </main>
  )
}
