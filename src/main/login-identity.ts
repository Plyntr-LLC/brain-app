/** Brain.app login greeting. Never the member name on the brain you switched into. */

export type HelloAccount = {
  email?: string
  appEmail?: string
  name?: string
  appName?: string
}

export type PlyntrOwner = { email: string; name: string }

export function helloName(acct: HelloAccount | null | undefined, plyntr: PlyntrOwner | null): string {
  const appEmail = String(acct?.appEmail || acct?.email || '')
    .trim()
    .toLowerCase()
  const storedApp = String(acct?.appName || '').trim()
  const plyntrEmail = String(plyntr?.email || '')
    .trim()
    .toLowerCase()
  const plyntrName = String(plyntr?.name || '').trim()
  if (plyntrEmail && appEmail === plyntrEmail) {
    if (plyntrName) return plyntrName
    if (storedApp) return storedApp
    return localPart(appEmail)
  }
  if (storedApp) return storedApp
  const name = String(acct?.name || '').trim()
  const email = String(acct?.email || '')
    .trim()
    .toLowerCase()
  if (name && appEmail && email === appEmail) return name
  return localPart(appEmail)
}

function localPart(email: string): string {
  if (!email.includes('@')) return 'there'
  return email.split('@')[0] || 'there'
}
