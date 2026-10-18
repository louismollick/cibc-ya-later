import { describe, expect, it } from 'vitest'
import template from '../shortcuts/cibc-otp-relay.template.json'
import { relayWorkflow } from '../src/main/shortcut'
import { mfaUrl } from '../src/shared/urls'

const base = 'https://bank.tailnet.ts.net/simplefin'
describe('iPhone relay export', () => {
  it('prefills the separate MFA URL without any bearer credential or setup question', () => {
    const workflow = relayWorkflow(base)
    const request = workflow.WFWorkflowActions.find(
      (action) => action.WFWorkflowActionIdentifier === 'is.workflow.actions.downloadurl',
    )?.WFWorkflowActionParameters
    expect(request).toMatchObject({
      WFURL: 'https://bank.tailnet.ts.net:8443/internal/mfa/code',
      WFHTTPMethod: 'POST',
      WFHTTPBodyType: 'JSON',
    })
    expect(workflow.WFWorkflowImportQuestions).toEqual([])
    expect(JSON.stringify(workflow)).not.toMatch(/Authorization|Bearer|PASTE_RELAY_SECRET/)
    expect(
      template.WFWorkflowActions.find(
        (action) => action.WFWorkflowActionIdentifier === 'is.workflow.actions.downloadurl',
      )?.WFWorkflowActionParameters.WFURL,
    ).toBe('CIBC_MAC_MFA_URL')
  })

  it('keeps native Shortcuts text and Count inputs connected', () => {
    expect(template.WFWorkflowInputContentItemClasses).toEqual(['WFStringContentItem'])
    const match = template.WFWorkflowActions.find(
      (action) => action.WFWorkflowActionIdentifier === 'is.workflow.actions.text.match',
    )?.WFWorkflowActionParameters
    const count = template.WFWorkflowActions.find(
      (action) => action.WFWorkflowActionIdentifier === 'is.workflow.actions.count',
    )?.WFWorkflowActionParameters
    expect(count).toMatchObject({
      Input: { Value: { Type: 'ActionOutput', OutputUUID: match?.UUID } },
      WFCountType: 'Items',
    })
  })

  it.each([
    'http://bank.tailnet.ts.net/simplefin',
    'https://example.com/simplefin',
    'https://bank.tailnet.ts.net:443/simplefin',
    'https://bank.tailnet.ts.net/simplefin?credential=secret',
    'https://user:secret@bank.tailnet.ts.net/simplefin',
  ])('rejects an unsafe or ambiguous destination: %s', (url) => {
    expect(() => relayWorkflow(url)).toThrow()
    expect(() => mfaUrl(url)).toThrow()
  })

  it.each([
    ['Your CIBC verification code is 123456.', ['123456']],
    ['CIBC code: 00123456', ['00123456']],
    ['CIBC code 1234567', ['1234567']],
    ['CIBC codes 123456 and 654321', ['123456', '654321']],
    ['CIBC reference ABC123456DEF', []],
    ['CIBC reference _123456_', []],
    ['CIBC reference ١123456٢', []],
    ['Call 18001234567', []],
    ['CIBC code 12345', []],
    ['No code here', []],
  ])('extracts only standalone codes from %s', (message, expected) => {
    const pattern = template.WFWorkflowActions.find(
      (action) => action.WFWorkflowActionIdentifier === 'is.workflow.actions.text.match',
    )?.WFWorkflowActionParameters.WFMatchTextPattern
    if (!pattern) throw new Error('Missing native matcher')
    expect([...message.matchAll(new RegExp(pattern, 'gu'))].map((match) => match[0])).toEqual(
      expected,
    )
  })
})
