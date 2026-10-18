import { useCallback, useEffect, useState } from 'react'

// Runs one IPC action at a time and keeps its error as a short sentence.
// Main-process errors arrive wrapped by Electron; only the app's message is shown.
export function useAction() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const run = useCallback(async (work: () => Promise<unknown>) => {
    setBusy(true)
    setError('')
    try {
      await work()
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message.replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, '')
          : 'Something went wrong.',
      )
    } finally {
      setBusy(false)
    }
  }, [])
  return { busy, error, run }
}

// Current time in seconds, refreshed on an interval, for countdowns and "ago" labels.
export function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(() => Date.now() / 1000)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now() / 1000), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])
  return now
}
