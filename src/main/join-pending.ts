export type PendingJoin = {
  memberToken: string
  teamSlug: string
  teamName: string
  repoUrl: string
  kind: string
  brandName: string
  memberEmail: string
  memberName: string
  memberRole: string
  scoutSeats: number | null
  packageTier: string | null
}

let pending: PendingJoin | null = null

export function setPendingJoin(next: PendingJoin | null): void {
  pending = next
}

export function getPendingJoin(): PendingJoin | null {
  return pending
}

export function clearPendingJoin(): void {
  pending = null
}

/** Build pending join from an Ads2AI invite resolve (setup code or add-company). */
export function pendingFromInvite(res: {
  memberToken: string
  teamSlug: string
  teamName?: string
  repoUrl?: string
  kind?: string
  scoutSeats?: number | null
  packageTier?: string | null
  member?: { email?: string; name?: string; role?: string }
  memberEmail?: string
  memberName?: string
  memberRole?: string
}): PendingJoin {
  const slug = String(res.teamSlug || '').trim()
  const member = res.member || {}
  return {
    memberToken: res.memberToken,
    teamSlug: slug,
    teamName: String(res.teamName || slug),
    repoUrl: String(res.repoUrl || ''),
    kind: String(res.kind || 'agency'),
    brandName: String(res.teamName || slug),
    memberEmail: String(member.email || res.memberEmail || '').toLowerCase(),
    memberName: String(member.name || res.memberName || ''),
    memberRole: String(member.role || res.memberRole || 'owner'),
    scoutSeats: res.scoutSeats ?? null,
    packageTier: res.packageTier ?? null
  }
}
