import { useEffect, useState } from 'react'
import type { AppState } from '../../shared/types'
import { Shell } from './Shell'
import { SignIn } from './SignIn'

// Loads state from the main process and re-reads it on every change event.
// Sign-in shows until credentials are saved, and again if CIBC rejects them.
export function App() {
  const [state, setState] = useState<AppState | null>(null)
  useEffect(() => {
    if (!window.cibc) return
    const load = () => void window.cibc.state().then(setState)
    load()
    return window.cibc.onChange(load)
  }, [])
  if (!window.cibc) return <p className="boot">Open this in the CIBC Ya Later app.</p>
  if (!state) return null
  return state.credentials === 'saved' ? <Shell state={state} /> : <SignIn state={state} />
}
