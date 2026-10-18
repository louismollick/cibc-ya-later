// Only application-authored messages may reach the UI. Playwright and bank
// errors can contain account identifiers, cookies, or request URLs.
export class UserError extends Error {}

export class CibcRefusedSignIn extends UserError {
  constructor() {
    super('CIBC refused the sign-in. Try again later.')
  }
}

export class CredentialsRejected extends UserError {
  constructor() {
    super('CIBC rejected the password.')
  }
}
export class MissingAccount extends UserError {
  constructor(
    readonly accountId: string,
    readonly name: string,
  ) {
    super(`${name} is no longer at CIBC.`)
  }
}
export class HistoryGap extends UserError {
  constructor() {
    super('History has a gap.')
  }
}
