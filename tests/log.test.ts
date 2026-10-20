import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { activityLog } from '../src/main/log'

it('appends timestamped lines and trims to the newest whole lines', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'log-')), 'sync-log.txt')
  const log = activityLog(file, 1000)
  for (let i = 0; i < 100; i++) log(`event ${i}`)
  const lines = readFileSync(file, 'utf8').trimEnd().split('\n')
  expect(readFileSync(file).length).toBeLessThanOrEqual(1000)
  expect(lines.at(-1)).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z event 99$/)
  expect(lines.every((line) => /Z event \d+$/.test(line))).toBe(true)
})
