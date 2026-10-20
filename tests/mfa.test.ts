import { afterEach, expect, it, vi } from 'vitest'
import { MfaGate } from '../src/main/mfa'

afterEach(() => vi.useRealTimers())
it.each(['early', 'late', 'cancel'] as const)(
  'offers manual code entry after 45 seconds: %s',
  async (mode) => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-17T12:00:00Z'))
    const gate = new MfaGate()
    const fallback = vi.fn()
    const code = gate.code(fallback)
    const result = code.catch(() => null)
    expect(gate.expiresAt).toBe(Date.now() / 1000 + 180)
    await vi.advanceTimersByTimeAsync(44_999)
    expect(fallback).not.toHaveBeenCalled()
    if (mode === 'early') gate.submit('123456', 'manual')
    else if (mode === 'cancel') gate.cancel()
    await vi.advanceTimersByTimeAsync(1)
    expect(fallback).toHaveBeenCalledTimes(mode === 'late' ? 1 : 0)
    if (mode === 'late') {
      expect(fallback).toHaveBeenCalledWith(Date.now() / 1000 + 135)
      gate.submit('123456', 'manual')
    }
    expect(await result).toEqual(mode === 'cancel' ? null : { code: '123456', source: 'manual' })
    expect(vi.getTimerCount()).toBe(0)
  },
)
it('expires the challenge after three minutes and clears both timers', async () => {
  vi.useFakeTimers()
  const gate = new MfaGate()
  const result = gate.code(() => {}).catch((error: unknown) => error)
  await vi.advanceTimersByTimeAsync(180_000)
  expect(await result).toBeInstanceOf(Error)
  expect(gate.active).toBe(false)
  expect(vi.getTimerCount()).toBe(0)
})
