export function validBaseUrl(input: string): boolean {
  try {
    const u = new URL(input)
    return (
      u.protocol === 'https:' &&
      u.hostname.endsWith('.ts.net') &&
      u.pathname === '/simplefin' &&
      !u.port &&
      !u.username &&
      !u.password &&
      !u.search &&
      !u.hash &&
      input === `${u.origin}/simplefin`
    )
  } catch {
    return false
  }
}

export function mfaUrl(baseUrl: string): string {
  if (!validBaseUrl(baseUrl)) throw new Error('Configure private Tailscale HTTPS first.')
  const url = new URL('/internal/mfa/code', baseUrl)
  url.port = '8443'
  return url.href
}
