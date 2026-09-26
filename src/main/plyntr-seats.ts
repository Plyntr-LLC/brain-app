import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { app } from 'electron'
import { brainRowForPath, currentBrainFolder } from './brains'
import { readSyncManifest } from './sync-manifest'
import { readTeamIdentity, readTeamMember } from './agency-brain'
import { brainRow, idForSlug, seatTokenForBrainFromVault, seatTokenForFolderFromVault, shellEmail, storeOwnedSeat, useFolderLookup } from './shell-vault'

export type PlyntrSeat = {
  seatToken: string
  slug: string
  email: string
  role: string
  repo: string
  bootstrap?: boolean
  wizardStep?: number
}

export type PendingPlyntrCreate = {
  createId: string
  wizardStep: number
  label: string
  org: string
  slug: string
  scoutEmail: string
  brainId?: string
}

export type PendingPlyntrJoin = {
  brainId: string
  repo: string
  role: string
  email: string
  name?: string
  slug: string
  label?: string
  bootstrap?: boolean
  wizardStep: number
}

type SeatFile = {
  byBrain: Record<string, PlyntrSeat>
  slugToBrain: Record<string, string>
}

function userFile(name: string): string {
  const dir = app.getPath('userData')
  mkdirSync(dir, { recursive: true })
  return join(dir, name)
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2))
  try {
    chmodSync(path, 0o600)
  } catch {
    /* windows */
  }
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return null
  }
}

export function plyntrDeviceId(): string {
  return createHash('sha256').update(app.getPath('userData')).digest('hex').slice(0, 32)
}

export function loginToken(): string {
  return `login:${randomBytes(16).toString('hex')}`
}

export function savePlyntrSeat(brainId: string, seat: PlyntrSeat): void {
  const id = String(brainId || '').trim()
  if (!id || !seat.seatToken) return
  storeOwnedSeat(id, seat.email, seat.role, seat.seatToken, seat.slug || '', seat.repo || '')
}

export function seatTokenForBrain(brainId: string): string {
  return seatTokenForBrainFromVault(brainId)
}

export function seatForBrain(brainId: string): PlyntrSeat | null {
  const hit = brainRow(String(brainId || '').trim())
  if (!hit || hit.owner !== shellEmail()) return null
  return { seatToken: hit.token, email: hit.email, role: hit.role, slug: hit.slug || '', repo: hit.repo || '' }
}

export function brainIdForSlug(slug: string): string {
  return idForSlug(slug)
}

/** Brain id for a folder: its brains.json row, then the slug of a Plyntr sync folder. Empty for Agency Brain and local folders with no brain id. */
export function brainIdForFolder(folder: string): string {
  const row = brainRowForPath(folder)
  if (row?.brainId) return row.brainId
  const manifest = readSyncManifest(folder)
  const ident = readTeamIdentity(folder)
  if (manifest?.ok && manifest.manifest.mode === 'plyntr' && ident?.slug) return brainIdForSlug(ident.slug)
  return ''
}

useFolderLookup(brainIdForFolder)

/** Role on a folder with no brain id: this shell's row in the folder's team file. Empty with no login or no row, and the guard then refuses protected paths. */
export function roleForKeylessWrite(folder: string): string {
  const email = shellEmail()
  return email ? readTeamMember(folder, email)?.role || '' : ''
}

export function seatTokenForFolder(folder: string): string {
  return seatTokenForFolderFromVault(folder)
}

export function seatTokenForActiveBrain(): string {
  return seatTokenForFolder(currentBrainFolder())
}

export function readPendingCreate(): PendingPlyntrCreate | null {
  const raw = readJson<PendingPlyntrCreate>(userFile('pending-plyntr-create.json'))
  if (!raw || !raw.createId) return null
  const step = Number(raw.wizardStep)
  return {
    createId: String(raw.createId),
    wizardStep: Number.isFinite(step) ? step : 0,
    label: String(raw.label || ''),
    org: String(raw.org || ''),
    slug: String(raw.slug || ''),
    scoutEmail: String(raw.scoutEmail || ''),
    brainId: raw.brainId ? String(raw.brainId) : undefined
  }
}

export function writePendingCreate(next: PendingPlyntrCreate): void {
  writeJson(userFile('pending-plyntr-create.json'), next)
}

export function clearPendingCreate(): void {
  const p = userFile('pending-plyntr-create.json')
  if (existsSync(p)) unlinkSync(p)
}

export function readPendingJoin(): PendingPlyntrJoin | null {
  const raw = readJson<PendingPlyntrJoin>(userFile('pending-plyntr-join.json'))
  if (!raw?.brainId) return null
  return raw
}

export function writePendingJoin(next: PendingPlyntrJoin): void {
  writeJson(userFile('pending-plyntr-join.json'), next)
}

export function clearPendingJoinPlyntr(): void {
  const p = userFile('pending-plyntr-join.json')
  if (existsSync(p)) unlinkSync(p)
}
