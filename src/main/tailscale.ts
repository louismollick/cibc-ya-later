import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { promisify } from 'node:util'
import { z } from 'zod'

const exec = promisify(execFile)
function binary() {
  const path = [
    '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
    '/opt/homebrew/bin/tailscale',
    '/usr/local/bin/tailscale',
  ].find(existsSync)
  if (!path) throw new Error('Install Tailscale and sign in on this Mac.')
  return path
}
// Runs the Tailscale CLI. Without a terminal in its environment, as when this app is
// launched from Finder, Tailscale.app's binary starts its GUI unless TAILSCALE_BE_CLI is set.
function tailscale(args: string[], timeout = 5000) {
  return exec(binary(), args, {
    timeout,
    maxBuffer: 1024 * 1024,
    env: { ...process.env, TAILSCALE_BE_CLI: '1' },
  })
}
const statusSchema = z.object({ BackendState: z.string(), Self: z.object({ DNSName: z.string() }) })
export async function tailscaleStatus() {
  try {
    const { stdout } = await tailscale(['status', '--json'])
    const status = statusSchema.parse(JSON.parse(stdout))
    const hostname = status.Self.DNSName.replace(/\.$/, '')
    if (status.BackendState !== 'Running')
      return {
        hostname,
        running: false,
        serving: false,
        message: 'Sign in to Tailscale on this Mac.',
      }
    const serve = await tailscale(['serve', 'status', '--json'])
    const data = JSON.parse(serve.stdout) as {
      Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>
      AllowFunnel?: Record<string, boolean>
    }
    const publicAccess = Object.values(data.AllowFunnel ?? {}).some(Boolean)
    const api = data.Web?.[`${hostname}:443`]?.Handlers?.['/simplefin']?.Proxy
    const mfa = data.Web?.[`${hostname}:8443`]?.Handlers?.['/internal/mfa/code']?.Proxy
    const serving =
      api === 'http://127.0.0.1:3610/simplefin' &&
      mfa === 'http://127.0.0.1:3611/internal/mfa/code' &&
      !publicAccess
    return {
      hostname,
      running: true,
      serving,
      message: publicAccess
        ? 'Tailscale Funnel is enabled. Disable public access before using CIBC Ya Later.'
        : serving
          ? 'HTTPS is private to your tailnet.'
          : 'Configure private HTTPS for SimpleFIN and MFA.',
    }
  } catch {
    return {
      running: false,
      hostname: null,
      serving: false,
      message: 'Tailscale is unavailable. Check that it is installed and running.',
    }
  }
}
export async function configureTailscale() {
  const status = await tailscaleStatus()
  if (!status.hostname) throw new Error(status.message)
  // Set only our two paths. Never reset existing Serve configuration or enable Funnel.
  await tailscale(
    [
      'serve',
      '--bg',
      '--yes',
      '--https=443',
      '--set-path=/simplefin',
      'http://127.0.0.1:3610/simplefin',
    ],
    15_000,
  )
  await tailscale(
    [
      'serve',
      '--bg',
      '--yes',
      '--https=8443',
      '--set-path=/internal/mfa/code',
      'http://127.0.0.1:3611/internal/mfa/code',
    ],
    15_000,
  )
  const updated = await tailscaleStatus()
  if (!updated.serving) throw new Error(updated.message)
  return `https://${status.hostname}/simplefin`
}
