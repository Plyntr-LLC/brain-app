import { parseGithubOrgLogin } from './github-org.ts'

export type OrgAdvice = {
  preferred: string
  free: boolean
  takenType: string
  suggestion: string
}

/** Login in the box when it is not the company slug. */
export function typedOrgReadyLogin(typedOrg: string, slug: string): string {
  const typed = parseGithubOrgLogin(typedOrg)
  if (!typed) return ''
  const company = parseGithubOrgLogin(String(slug || '').replace(/-brain$/i, ''))
  if (company && typed.toLowerCase() === company.toLowerCase()) return ''
  if (company && typed.toLowerCase() === `${company}-brain`.toLowerCase()) return ''
  return typed
}

export function orgStepCopy(label: string, slug: string, advice: OrgAdvice | null, typedOrg = ''): string {
  const ready = typedOrgReadyLogin(typedOrg, slug)
  if (ready) {
    const repoSlug = parseGithubOrgLogin(String(slug || '').replace(/-brain$/i, '')) || slug
    return `This Mac will use the GitHub organization ${ready}. Click Use this organization. This Mac then creates ${ready}/${repoSlug}-brain.`
  }
  const company = label || 'This company'
  if (!slug) {
    return `${company} is not on GitHub yet. Open GitHub, sign in, and create a free organization. After GitHub creates it, copy the web address at the top of the browser and paste it here. It looks like github.com/orgs/the-name.`
  }
  if (!advice || advice.preferred !== slug) {
    return `${company} is not on GitHub yet. Open GitHub, sign in, and create a free organization. After GitHub creates it, copy the web address at the top of the browser and paste it here.`
  }
  if (advice.free) {
    return `${company} is not on GitHub yet. Open GitHub, sign in, and create a free organization. Set the organization account name to ${slug}. After GitHub creates it, the address bar is github.com/orgs/${slug}. Paste that address.`
  }
  if (advice.takenType === 'User') {
    return `${slug} is already a person's GitHub login, so an organization cannot use that name. Open GitHub and set the organization account name to ${advice.suggestion}. After GitHub creates it, copy the web address at the top of the browser and paste it here.`
  }
  if (advice.takenType === 'Organization' && advice.suggestion && advice.suggestion !== slug) {
    return `${slug} is already an organization. If it is yours, paste ${slug}. If it is not, create ${advice.suggestion} and copy the web address at the top of the browser and paste it here.`
  }
  if (advice.takenType === 'Organization') {
    return `${slug} is already an organization. If it is yours, paste ${slug}. If it is not, pick a different organization name on GitHub and copy the web address at the top of the browser and paste it here.`
  }
  return `${company} is not on GitHub yet. Open GitHub and create a free organization. After GitHub creates it, copy the web address at the top of the browser and paste it here.`
}

export function orgUseError(
  raw: string,
  slug: string,
  pastedRepo: boolean,
  look: { reason?: string; detail?: string; login?: string },
  freeName: string
): string {
  if (pastedRepo && look.reason === 'personal-account') {
    return `${raw} is not a GitHub organization. ${slug} is already a person's login, so an organization cannot use that name. On GitHub, set the organization account name to ${freeName}. After GitHub creates it, copy the web address at the top of the browser and paste it here.`
  }
  if (pastedRepo && look.reason === 'not-found') {
    return `${raw} is not a GitHub organization. Create the organization first. A free name is ${freeName}. After GitHub creates it, the address bar is github.com/orgs/${freeName}. Paste that address.`
  }
  if (look.reason === 'not-found') {
    const name = look.login || raw
    return `GitHub has no organization named ${name}. After you create it, the address bar is github.com/orgs/${name}. Paste that address.`
  }
  return look.detail || 'That GitHub name is not an organization yet. Copy the web address at the top of the browser and paste it here after you create it.'
}

/** Platform calls that answer 401/403 throw this text, so the company screen can send Joe back to sign in. */
export const PLATFORM_AUTH = 'Plyntr platform sign-in expired. Sign in to platform sync first.'

/** Electron wraps IPC throws as `Error invoking remote method 'channel': Error: …`. Setup screens should show the inner line. */
export function ipcErrorText(err: unknown): string {
  const text = String((err as Error)?.message || err || '')
  return text.replace(/^Error invoking remote method '[^']*':\s*/, '').replace(/^(?:\w*Error:\s*)+/, '').trim()
}

/** How the company screen shows a failed company list. Only fetch/network failures get the offline note. */
export function companiesLoadError(message: string): { login: boolean; note: string } {
  const text = String(message || '')
  if (text.includes('Sign in to platform sync first')) return { login: true, note: '' }
  if (/TypeError|fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|network/i.test(text)) {
    return { login: false, note: 'Could not reach Plyntr for the company list. The brains on this computer are still listed.' }
  }
  const short = ipcErrorText(text)
  return { login: false, note: `Could not load the company list. ${short || 'Try again.'}` }
}

/** A code whose brain was removed. The worker answers `gone`; the app never shows raw `not found` for it. */
export const GONE_BRAIN_CODE = 'That code was for a brain that is no longer set up. Ask for a fresh invite to the one you still use.'

export const CODE_NOT_LIVE = 'That email is not on a live brain. Ask for a fresh invite.'

export const CODE_UNREACHABLE = 'Could not reach sign-in to send a code. Check your connection and try again.'

export const CODE_SENT_MANY =
  'We emailed a code for each place this address is still set up. If you get more than one, use the one for the brain you want to open.'

/** Shown when only project sync answered. It answers ok for every address, so this never says who is invited. */
export const CODE_PROJECT_HEDGE =
  'If this address has an invite, a code is on its way. Nothing in a few minutes? Ask the person who runs your brain for an invite code.'

export const CODE_DID_NOT_WORK = 'That code did not work. Check the newest email and type it exactly.'

const NO_MATCH = /not found|did not work|didn't work|invalid|incorrect|wrong|no such|unknown|bad code|HTTP 4\d\d|^\s*$/i

/** Several systems may have tried one code. Show the line that tells the person the most, never raw `not found`. */
export function pickCodeError(messages: string[]): string {
  const all = messages.map((m) => ipcErrorText(m))
  if (all.some((m) => m === GONE_BRAIN_CODE || /no longer set up/i.test(m))) return GONE_BRAIN_CODE
  const used = all.find((m) => /already used/i.test(m))
  if (used) return used
  if (all.some((m) => /expired/i.test(m))) return 'That code has expired. Ask for a fresh one.'
  const revoked = all.find((m) => /revoked/i.test(m))
  if (revoked) return revoked
  const real = all.find((m) => !NO_MATCH.test(m))
  return real || CODE_DID_NOT_WORK
}
