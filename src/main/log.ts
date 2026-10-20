import { appendFileSync, readFileSync, statSync, writeFileSync } from 'node:fs'

export type Log = (line: string) => void
/**
 * Local activity log for sync runs and code relay requests, so you can check
 * afterwards what happened. Keeps roughly the newest `max` bytes (about 50 runs).
 * Never throws, and callers must never pass secrets.
 */
export function activityLog(file: string, max = 256_000): Log {
  return (line) => {
    try {
      appendFileSync(file, `${new Date().toISOString()} ${line}\n`, { mode: 0o600 })
      if (statSync(file).size <= max) return
      const text = readFileSync(file, 'utf8')
      writeFileSync(file, text.slice(text.indexOf('\n', text.length - max / 2) + 1), {
        mode: 0o600,
      })
    } catch {}
  }
}
