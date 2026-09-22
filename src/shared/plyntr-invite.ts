export const PLYNTR_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
export const PLYNTR_INVITE_LEN = 10

/** Remove dashes and spaces, then uppercase. No other stripping. */
export function normalizePlyntrInviteCode(raw: string): string {
  return String(raw || '').replace(/[-\s]/g, '').toUpperCase()
}

export function authCodeRoute(raw: string): 'plyntr' | 'other' {
  return normalizePlyntrInviteCode(raw).length === PLYNTR_INVITE_LEN ? 'plyntr' : 'other'
}

export function displayPlyntrCode(raw: string): string {
  const n = normalizePlyntrInviteCode(raw)
  if (n.length !== PLYNTR_INVITE_LEN) return n
  return `${n.slice(0, 4)}-${n.slice(4, 8)}-${n.slice(8)}`
}

export function slugFromBusinessName(name: string): string {
  let s = String(name || '').toLowerCase()
  s = s.replace(/\s+/g, '-')
  s = s.replace(/'/g, '')
  s = s.replace(/&/g, 'and')
  s = s.replace(/[^a-z0-9-]/g, '')
  s = s.replace(/-+/g, '-')
  s = s.replace(/^-+|-+$/g, '')
  s = s.slice(0, 40)
  return s.replace(/-+$/g, '')
}
