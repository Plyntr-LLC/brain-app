export const SUPERADMIN_EMAIL = 'joe@plyntr.com'

export function isJoeSuperAdmin(
  acct: { email?: string; appEmail?: string; source?: string } | null | undefined,
  settings: { superAdmin?: boolean }
): boolean {
  const email = String(acct?.appEmail || acct?.email || '')
    .trim()
    .toLowerCase()
  if (email !== SUPERADMIN_EMAIL) return false
  if (acct?.source === 'team-file' || acct?.source === 'hq-sync') return false
  return settings.superAdmin !== false
}
