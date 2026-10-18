import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { exportRelayShortcut } from '../src/main/shortcut'
import { tailscaleStatus } from '../src/main/tailscale'

const { values } = parseArgs({
  options: { 'base-url': { type: 'string' }, output: { type: 'string' } },
})
let baseUrl = values['base-url']
if (!baseUrl) {
  const status = await tailscaleStatus()
  if (!status.hostname) throw new Error('Sign in to Tailscale or pass --base-url.')
  baseUrl = `https://${status.hostname}/simplefin`
}
const destination = resolve(values.output ?? `${homedir()}/Downloads/CIBC OTP Relay.shortcut`)
console.log(
  'Signing the relay with your Mac URL. Access is controlled by Tailscale, with no relay secret.',
)
await exportRelayShortcut(baseUrl, destination)
console.log(`Saved ${destination}`)
