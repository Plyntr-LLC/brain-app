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
