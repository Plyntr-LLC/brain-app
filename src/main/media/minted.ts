import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { normalizeMediaRoot } from './hmac-seat.ts'

export type MintedInvite = {
  inviteEmail: string
  roots: string[]
  mintedAt: number
}

function assertBrainId(id: string): string {
  const s = String(id || '')
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(s)) throw new Error('Bad media brain id.')
  return s
}

export function mintedFilePath(userData: string, mediaBrainId: string): string {
  return join(userData, 'media', assertBrainId(mediaBrainId), 'minted.json')
}

export function readMintedInvites(userData: string, mediaBrainId: string): MintedInvite[] {
  const path = mintedFilePath(userData, mediaBrainId)
  if (!existsSync(path)) return []
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { invites?: MintedInvite[] }
    return Array.isArray(raw.invites) ? raw.invites : []
  } catch {
    return []
  }
}

export function recordMintedInvite(
  userData: string,
  mediaBrainId: string,
  invite: { inviteEmail: string; roots: string[]; mintedAt?: number }
): MintedInvite {
  const row: MintedInvite = {
    inviteEmail: String(invite.inviteEmail || '')
      .trim()
      .toLowerCase(),
    roots: (invite.roots || []).map(normalizeMediaRoot).filter(Boolean),
    mintedAt: invite.mintedAt || Date.now()
  }
  const path = mintedFilePath(userData, mediaBrainId)
  mkdirSync(dirname(path), { recursive: true })
  const invites = readMintedInvites(userData, mediaBrainId).filter(
    (m) => !(m.inviteEmail === row.inviteEmail && sameRoots(m.roots, row.roots))
  )
  invites.push(row)
  writeFileSync(path, JSON.stringify({ invites }))
  return row
}

export function sameRoots(a: string[], b: string[]): boolean {
  const na = [...new Set((a || []).map(normalizeMediaRoot).filter(Boolean))].sort()
  const nb = [...new Set((b || []).map(normalizeMediaRoot).filter(Boolean))].sort()
  return na.length === nb.length && na.every((r, i) => r === nb[i])
}

export function mintedMatchesDevice(
  minted: MintedInvite[],
  email: string,
  roots: string[]
): boolean {
  const want = String(email || '')
    .trim()
    .toLowerCase()
  return minted.some((m) => m.inviteEmail === want && sameRoots(m.roots, roots))
}
