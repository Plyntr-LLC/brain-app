/** In-memory only. Never write to disk or logs. */
let memberToken: string | null = null

export function setMemberToken(token: string | null): void {
  memberToken = token
}

export function getMemberToken(): string {
  if (!memberToken) throw new Error('Sign in first')
  return memberToken
}
