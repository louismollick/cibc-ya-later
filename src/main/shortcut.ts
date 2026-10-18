import { execFile } from 'node:child_process'
import { chmod, mkdtemp, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import template from '../../shortcuts/cibc-otp-relay.template.json'
import { mfaUrl } from '../shared/urls'

const exec = promisify(execFile)

// Tailscale authorizes the relay, so the signed workflow contains no credential.
export function relayWorkflow(baseUrl: string) {
  const endpoint = mfaUrl(baseUrl)
  return {
    ...template,
    WFWorkflowActions: template.WFWorkflowActions.map((action) =>
      action.WFWorkflowActionIdentifier === 'is.workflow.actions.downloadurl'
        ? {
            ...action,
            WFWorkflowActionParameters: { ...action.WFWorkflowActionParameters, WFURL: endpoint },
          }
        : action,
    ),
  }
}

/** Sign with Apple's native tool, then atomically replace the selected export file. */
export async function exportRelayShortcut(baseUrl: string, destination: string) {
  const workflow = relayWorkflow(baseUrl)
  const directory = await mkdtemp(join(dirname(destination), '.cibc-shortcut-'))
  try {
    const input = join(directory, 'relay.unsigned.shortcut')
    const signed = join(directory, 'relay.shortcut')
    await writeFile(input, JSON.stringify(workflow), { mode: 0o600 })
    await exec('/usr/bin/plutil', ['-convert', 'binary1', input], { timeout: 10_000 })
    try {
      await exec(
        '/usr/bin/shortcuts',
        ['sign', '--mode', 'anyone', '--input', input, '--output', signed],
        {
          timeout: 90_000,
          maxBuffer: 64 * 1024,
        },
      )
    } catch {
      throw new Error(
        'Apple Shortcut signing failed. Check your internet connection and Shortcuts app, then retry.',
      )
    }
    if (!(await stat(signed)).size) throw new Error('Apple returned an empty Shortcut file.')
    await chmod(signed, 0o600)
    await rename(signed, destination)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
