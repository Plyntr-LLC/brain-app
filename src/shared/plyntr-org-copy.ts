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
    return `${company} is not on GitHub yet. Open GitHub, sign in, and create a free organization. After GitHub creates it, paste the address bar. It looks like github.com/orgs/the-name.`
  }
  if (!advice || advice.preferred !== slug) {
    return `${company} is not on GitHub yet. Open GitHub, sign in, and create a free organization. After GitHub creates it, paste the address bar.`
  }
  if (advice.free) {
    return `${company} is not on GitHub yet. Open GitHub, sign in, and create a free organization. Set the organization account name to ${slug}. After GitHub creates it, the address bar is github.com/orgs/${slug}. Paste that address.`
  }
  if (advice.takenType === 'User') {
    return `${slug} is already a person's GitHub login, so an organization cannot use that name. Open GitHub and set the organization account name to ${advice.suggestion}. After GitHub creates it, paste the address bar.`
  }
  if (advice.takenType === 'Organization' && advice.suggestion && advice.suggestion !== slug) {
    return `${slug} is already an organization. If it is yours, paste ${slug}. If it is not, create ${advice.suggestion} and paste that address bar.`
  }
  if (advice.takenType === 'Organization') {
    return `${slug} is already an organization. If it is yours, paste ${slug}. If it is not, pick a different organization name on GitHub and paste the address bar.`
  }
  return `${company} is not on GitHub yet. Open GitHub and create a free organization. After GitHub creates it, paste the address bar.`
}

export function orgUseError(
  raw: string,
  slug: string,
  pastedRepo: boolean,
  look: { reason?: string; detail?: string; login?: string },
  freeName: string
): string {
  if (pastedRepo && look.reason === 'personal-account') {
    return `${raw} is not a GitHub organization. ${slug} is already a person's login, so an organization cannot use that name. On GitHub, set the organization account name to ${freeName}. After GitHub creates it, paste the address bar.`
  }
  if (pastedRepo && look.reason === 'not-found') {
    return `${raw} is not a GitHub organization. Create the organization first. A free name is ${freeName}. After GitHub creates it, the address bar is github.com/orgs/${freeName}. Paste that address.`
  }
  if (look.reason === 'not-found') {
    const name = look.login || raw
    return `GitHub has no organization named ${name}. After you create it, the address bar is github.com/orgs/${name}. Paste that address.`
  }
  return look.detail || 'That GitHub name is not an organization yet. Paste the address bar after you create it.'
}
