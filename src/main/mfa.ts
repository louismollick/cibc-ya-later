import { UserError } from './errors'
import { codeSchema } from './validation'
/** Where a verification code came from: the iPhone code relay or typed into the app. */
export type MfaSource = 'relay' | 'manual'
export type MfaCode = { code: string; source: MfaSource }
export class MfaGate {
  private waiting: {
    resolve: (code: MfaCode) => void
    reject: (error: Error) => void
    timer: ReturnType<typeof setTimeout>
    expires: number
  } | null = null
  private attempts = 0
  private sequence = 0
  get expiresAt() {
    return this.waiting ? Math.floor(this.waiting.expires / 1000) : null
  }
  // Offer manual entry only after the relay has had 45 seconds to deliver.
  async code(fallback: (expiresAt: number) => void) {
    const pending = this.wait()
    const timer = setTimeout(() => {
      if (this.active && this.expiresAt !== null) fallback(this.expiresAt)
    }, 45_000)
    try {
      return await pending
    } finally {
      clearTimeout(timer)
    }
  }
  get challenge() {
    return this.active ? this.sequence : null
  }
  get active() {
    return this.waiting !== null && Date.now() < this.waiting.expires
  }
  wait(timeoutMs = 180_000): Promise<MfaCode> {
    if (this.waiting) throw new UserError('A CIBC MFA challenge is already active.')
    this.attempts = 0
    this.sequence++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.cancel('CIBC verification timed out.'), timeoutMs)
      this.waiting = { resolve, reject, timer, expires: Date.now() + timeoutMs }
    })
  }
  submit(value: string, source: MfaSource, challenge = this.challenge) {
    if (!this.active) throw new UserError('No CIBC login is awaiting a verification code.')
    if (challenge === null || challenge !== this.challenge)
      throw new UserError('The CIBC verification challenge has changed.')
    this.attempts++
    if (this.attempts > 5) {
      this.cancel('Too many invalid MFA submissions.')
      throw new UserError('Too many MFA submissions.')
    }
    const code = codeSchema.parse(value)
    const waiting = this.waiting
    if (!waiting) throw new UserError('MFA challenge expired.')
    clearTimeout(waiting.timer)
    this.waiting = null
    waiting.resolve({ code, source })
  }
  cancel(reason = 'CIBC login cancelled.') {
    const waiting = this.waiting
    this.waiting = null
    if (waiting) {
      clearTimeout(waiting.timer)
      waiting.reject(new UserError(reason))
    }
  }
}
