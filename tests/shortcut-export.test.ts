import { mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { exportRelayShortcut } from '../src/main/shortcut'

const { tool } = vi.hoisted(() => ({
  tool: vi.fn<(binary: string, args: string[]) => Promise<{ stdout: string; stderr: string }>>(),
}))
vi.mock('node:child_process', () => ({
  execFile: Object.assign(vi.fn(), { [Symbol.for('nodejs.util.promisify.custom')]: tool }),
}))
let directory: string
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'cibc-export-test-'))
  tool.mockReset().mockImplementation(async (binary, args) => {
    if (binary === '/usr/bin/shortcuts') {
      const output = args[args.indexOf('--output') + 1]
      if (!output) throw new Error('Missing output')
      await writeFile(output, 'signed test fixture')
    }
    return { stdout: '', stderr: '' }
  })
})
afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

it('replaces a destination symlink without overwriting or chmodding its target', async () => {
  const target = join(directory, 'unrelated.txt'),
    destination = join(directory, 'relay.shortcut')
  await writeFile(target, 'keep me', { mode: 0o644 })
  await symlink(target, destination)
  await exportRelayShortcut('https://bank.tailnet.ts.net/simplefin', destination)
  expect(await readFile(target, 'utf8')).toBe('keep me')
  expect((await stat(target)).mode & 0o777).toBe(0o644)
  expect(await readFile(destination, 'utf8')).toBe('signed test fixture')
  expect((await stat(destination)).mode & 0o777).toBe(0o600)
  expect((await readdir(directory)).sort()).toEqual(['relay.shortcut', 'unrelated.txt'])
})

it('keeps a previous export intact and cleans up when Apple signing fails', async () => {
  const destination = join(directory, 'relay.shortcut')
  await writeFile(destination, 'previous signed export')
  tool.mockImplementation(async (binary) => {
    if (binary === '/usr/bin/shortcuts') throw new Error('Apple unavailable')
    return { stdout: '', stderr: '' }
  })
  await expect(
    exportRelayShortcut('https://bank.tailnet.ts.net/simplefin', destination),
  ).rejects.toThrow('Apple Shortcut signing failed')
  expect(await readFile(destination, 'utf8')).toBe('previous signed export')
  expect(await readdir(directory)).toEqual(['relay.shortcut'])
})
