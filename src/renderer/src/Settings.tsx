import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import type { AppState, Settings as SettingsValue } from '../../shared/types'
import { day } from './lib/format'
import { useAction } from './lib/hooks'
import { Banner, isBusy, PaneHead } from './Shell'

const weekdays = [
  ['M', 'Monday', 1],
  ['T', 'Tuesday', 2],
  ['W', 'Wednesday', 3],
  ['T', 'Thursday', 4],
  ['F', 'Friday', 5],
  ['S', 'Saturday', 6],
  ['S', 'Sunday', 0],
] as const

// Every change saves immediately. Settings are locked while a sync runs.
export function Settings({ state }: { state: AppState }) {
  const { settings } = state
  const { busy, error, run } = useAction()
  const locked = busy || isBusy(state)
  const save = useCallback(
    (next: SettingsValue) => void run(() => window.cibc.saveSettings(next)),
    [run],
  )
  const [time, setTime] = useState(settings.schedule.time)
  useEffect(() => setTime(settings.schedule.time), [settings.schedule.time])
  useEffect(() => {
    if (time === settings.schedule.time || !/^\d{2}:\d{2}$/.test(time)) return
    const timer = setTimeout(
      () => save({ ...settings, schedule: { ...settings.schedule, time } }),
      400,
    )
    return () => clearTimeout(timer)
  }, [time, settings, save])
  const toggleDay = (value: number) => {
    const current = settings.schedule.weekdays
    const next = current.includes(value) ? current.filter((d) => d !== value) : [...current, value]
    if (next.length) save({ ...settings, schedule: { ...settings.schedule, weekdays: next } })
  }
  const relayReady = Boolean(state.simplefinUrl) && state.api.running
  return (
    <>
      <PaneHead title="Settings" />
      {error && <Banner>{error}</Banner>}
      <dl className="settings">
        <dt>Sync on</dt>
        <dd className="days">
          {weekdays.map(([letter, name, value]) => (
            <button
              type="button"
              key={value}
              aria-label={name}
              aria-pressed={settings.schedule.weekdays.includes(value)}
              disabled={locked}
              onClick={() => toggleDay(value)}
            >
              {letter}
            </button>
          ))}
        </dd>
        <dt>At</dt>
        <dd>
          <Input
            className="time"
            type="time"
            aria-label="Sync time"
            disabled={locked}
            value={time}
            onChange={(e) => setTime(e.target.value)}
          />
        </dd>
        <dt>Open at login</dt>
        <dd>
          <Switch
            aria-label="Open at login"
            disabled={locked}
            checked={settings.launchAtLogin}
            onCheckedChange={(launchAtLogin) => save({ ...settings, launchAtLogin })}
          />
        </dd>
        <dt>iPhone relay</dt>
        <dd>
          <Button
            variant="outline"
            size="sm"
            disabled={busy || !relayReady}
            onClick={() => void run(window.cibc.exportShortcut)}
          >
            Export Shortcut
          </Button>
        </dd>
        <dt>Full history</dt>
        <dd>
          {state.fullHistory.completedAt && <span>{day(state.fullHistory.completedAt)}</span>}
          <Button
            variant="outline"
            size="sm"
            disabled={locked}
            onClick={() => void run(window.cibc.downloadFullHistory)}
          >
            {state.fullHistory.completedAt ? 'Download again' : 'Download full history'}
          </Button>
        </dd>
        <dt>CIBC</dt>
        <dd>
          {state.cardLast4 && <span>•• {state.cardLast4}</span>}
          <Button
            variant="link"
            size="sm"
            className="quiet"
            disabled={locked}
            onClick={() => void run(window.cibc.signOut)}
          >
            Sign out
          </Button>
        </dd>
      </dl>
    </>
  )
}
