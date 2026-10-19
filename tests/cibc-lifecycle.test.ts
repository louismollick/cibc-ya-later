import { beforeEach, describe, expect, it, vi } from 'vitest'

const mock = vi.hoisted(() => ({ launch: vi.fn() }))
vi.mock('playwright', () => ({ chromium: { launch: mock.launch } }))

import { join } from 'node:path'
import { CibcDownloader } from '../src/main/cibc'
import { CibcRefusedSignIn } from '../src/main/errors'
import { MfaGate } from '../src/main/mfa'

const browserRoot = join(process.cwd(), 'node_modules/.cache/ms-playwright')
const options = () => ({
  browserRoot,
  session: vi.fn(async () => undefined as string | undefined),
  saveSession: vi.fn(async () => {}),
  credentials: vi.fn(async () => null),
  mfa: new MfaGate(),
  status: vi.fn(),
})
beforeEach(() => {
  mock.launch.mockReset()
})
describe('CIBC browser lifetime', () => {
  it('does not launch Chromium if encrypted state cannot be read', async () => {
    const config = options()
    config.session.mockRejectedValue(new Error('locked'))
    await expect(new CibcDownloader(config).download(60)).rejects.toThrow('locked')
    expect(mock.launch).not.toHaveBeenCalled()
  })
  it('cancels a launch that resolves after the cancel button was pressed', async () => {
    const config = options(),
      close = vi.fn(async () => {}),
      newContext = vi.fn()
    let finish: (value: unknown) => void = () => {}
    mock.launch.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const downloader = new CibcDownloader(config),
      operation = downloader.download(60)
    await vi.waitFor(() => expect(mock.launch).toHaveBeenCalled())
    await downloader.cancel()
    finish({ close, newContext })
    await expect(operation).rejects.toThrow('cancelled')
    expect(close).toHaveBeenCalledTimes(1)
    expect(newContext).not.toHaveBeenCalled()
    expect(config.saveSession).not.toHaveBeenCalled()
  })
})

it.each(["We're sorry, there's been an error", 'There’s been an error', '[Result #0001]'])(
  'reports a refused sign-in for visible %s',
  async (text) => {
    const config = options()
    const close = vi.fn(async () => {})
    const addInitScript = vi.fn(async () => {})
    const getByText = vi.fn((pattern: RegExp) => ({
      filter: () => ({ count: async () => Number(pattern.test(text)) }),
    }))
    mock.launch.mockResolvedValue({
      version: () => '156.0.0.0',
      close,
      newContext: async () => ({
        addInitScript,
        setDefaultTimeout: () => {},
        newPage: async () => ({
          goto: async () => {},
          on: () => {},
          mainFrame: () => ({}),
          url: () => 'https://www.cibconline.cibc.com/',
          locator: () => ({ filter: () => ({ count: async () => 0 }) }),
          getByText,
        }),
      }),
    })
    await expect(new CibcDownloader(config).download(60)).rejects.toBeInstanceOf(CibcRefusedSignIn)
    expect(addInitScript).toHaveBeenCalledTimes(1)
    expect(getByText).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledTimes(1)
    expect(config.saveSession).not.toHaveBeenCalled()
  },
)

it('does not create an MFA challenge when visibility resolves after cancellation', async () => {
  const config = options()
  const challenge = vi.spyOn(config.mfa, 'code')
  let finish: (visible: boolean) => void = () => {}
  const visibility = vi.fn(
    () =>
      new Promise<boolean>((resolve) => {
        finish = resolve
      }),
  )
  const code = { first: () => ({ isVisible: visibility }) }
  mock.launch.mockResolvedValue({
    version: () => '156.0.0.0',
    close: vi.fn(async () => {}),
    newContext: async () => ({
      addInitScript: async () => {},
      setDefaultTimeout: () => {},
      newPage: async () => ({
        goto: async () => {},
        on: () => {},
        mainFrame: () => ({}),
        url: () => 'https://www.cibconline.cibc.com/',
        locator: () => ({
          filter: () => ({ count: async () => 0 }),
          first: () => ({ isVisible: async () => false }),
        }),
        getByText: () => ({ filter: () => ({ count: async () => 0 }) }),
        getByRole: (_role: string, { name }: { name: RegExp }) =>
          name.test('Card number') ? { isVisible: async () => false } : { or: () => code },
      }),
    }),
  })
  const downloader = new CibcDownloader(config)
  const operation = downloader.download(60)
  await vi.waitFor(() => expect(visibility).toHaveBeenCalled())
  await downloader.cancel()
  finish(true)
  await expect(operation).rejects.toThrow('cancelled')
  expect(challenge).not.toHaveBeenCalled()
  expect(config.mfa.active).toBe(false)
  expect(config.status.mock.calls.some(([phase]) => phase === 'code-needed')).toBe(false)
  expect(config.saveSession).not.toHaveBeenCalled()
})

it('recognizes a card-step rejection before password submission', async () => {
  const config = {
    ...options(),
    credentials: vi.fn(async () => ({ card: 'fixture-card', password: 'fixture-password' })),
  }
  let submitted = false
  const fill = vi.fn(async () => {})
  mock.launch.mockResolvedValue({
    version: () => '156.0.0.0',
    close: vi.fn(async () => {}),
    newContext: async () => ({
      addInitScript: async () => {},
      setDefaultTimeout: () => {},
      newPage: async () => ({
        goto: async () => {},
        on: () => {},
        mainFrame: () => ({}),
        url: () => 'https://www.cibconline.cibc.com/',
        locator: () => ({ filter: () => ({ count: async () => 0 }) }),
        getByText: (pattern: RegExp) => ({
          filter: () => ({
            count: async () => Number(submitted && pattern.test('Your card number is invalid.')),
          }),
        }),
        getByRole: () => ({
          isVisible: async () => true,
          fill,
          click: async () => {
            submitted = true
          },
          or: () => ({}),
        }),
        waitForTimeout: async () => {},
      }),
    }),
  })
  await expect(new CibcDownloader(config).download(60)).rejects.toThrow(
    'CIBC rejected the password.',
  )
  expect(fill).toHaveBeenCalledExactlyOnceWith('fixture-card')
  expect(config.saveSession).not.toHaveBeenCalled()
})

it('drops Akamai bot cookies from the saved session', async () => {
  const config = options()
  const cookie = (name: string) => ({ name, value: 'x', domain: '.cibc.com', path: '/' })
  config.session.mockResolvedValue(
    JSON.stringify({
      cookies: ['_abck', 'bm_sz', 'ak_bmsc', 'PIM-SESSION-ID'].map(cookie),
      origins: [],
    }),
  )
  const newContext = vi.fn(async () => {
    throw new Error('stop')
  })
  mock.launch.mockResolvedValue({ version: () => '156.0.0.0', close: async () => {}, newContext })
  await expect(new CibcDownloader(config).download(60)).rejects.toThrow('stop')
  expect(newContext).toHaveBeenCalledWith(
    expect.objectContaining({
      storageState: { cookies: [cookie('PIM-SESSION-ID')], origins: [] },
    }),
  )
})

it('retries a refused card number with fresh cookies, then gives up', async () => {
  const config = {
    ...options(),
    credentials: vi.fn(async () => ({ card: 'fixture-card', password: 'fixture-password' })),
  }
  let refused = false
  const fill = vi.fn(async () => {})
  const clearCookies = vi.fn(async () => {})
  const goto = vi.fn(async () => {
    refused = false
  })
  mock.launch.mockResolvedValue({
    version: () => '156.0.0.0',
    close: vi.fn(async () => {}),
    newContext: async () => ({
      addInitScript: async () => {},
      setDefaultTimeout: () => {},
      newPage: async () => ({
        goto,
        on: () => {},
        mainFrame: () => ({}),
        context: () => ({ clearCookies }),
        url: () => 'https://www.cibconline.cibc.com/',
        locator: () => ({ filter: () => ({ count: async () => 0 }) }),
        getByText: (pattern: RegExp) => ({
          filter: () => ({ count: async () => Number(refused && pattern.test('[Result #0001]')) }),
        }),
        getByRole: () => ({
          isVisible: async () => !refused,
          fill,
          click: async () => {
            refused = true
          },
          or: () => ({}),
        }),
        waitForTimeout: async () => {},
      }),
    }),
  })
  await expect(new CibcDownloader(config).download(60)).rejects.toBeInstanceOf(CibcRefusedSignIn)
  expect(fill).toHaveBeenCalledTimes(3)
  expect(clearCookies).toHaveBeenCalledTimes(2)
  expect(goto).toHaveBeenCalledTimes(3)
})
