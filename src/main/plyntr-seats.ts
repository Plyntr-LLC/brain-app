import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { app } from 'electron'
import { brainRowForPath, currentBrainFolder } from './brains'
import { readSyncManifest } from './sync-manifest'
import { readTeamIdentity } from './agency-brain'

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

function loadSeats(): SeatFile {
  const raw = readJson<SeatFile>(userFile('plyntr-seats.json'))
  return {
    byBrain: raw?.byBrain && typeof raw.byBrain === 'object' ? raw.byBrain : {},
    slugToBrain: raw?.slugToBrain && typeof raw.slugToBrain === 'object' ? raw.slugToBrain : {}
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
  const file = loadSeats()
  file.byBrain[id] = seat
  if (seat.slug) file.slugToBrain[seat.slug.toLowerCase()] = id
  writeJson(userFile('plyntr-seats.json'), file)
}

export function seatTokenForBrain(brainId: string): string {
  const row = loadSeats().byBrain[String(brainId || '').trim()]
  return String(row?.seatToken || '')
}

export function seatForBrain(brainId: string): PlyntrSeat | null {
  return loadSeats().byBrain[String(brainId || '').trim()] || null
}

export function brainIdForSlug(slug: string): string {
  return loadSeats().slugToBrain[String(slug || '').trim().toLowerCase()] || ''
}

export function seatTokenForFolder(folder: string): string {
  const row = brainRowForPath(folder)
  if (row?.brainId) {
    const token = seatTokenForBrain(row.brainId)
    if (token) return token
  }
  if (row?.seatToken) return row.seatToken
  const manifest = readSyncManifest(folder)
  const ident = readTeamIdentity(folder)
  if (manifest?.ok && manifest.manifest.mode === 'plyntr' && ident?.slug) {
    const id = brainIdForSlug(ident.slug)
    if (id) return seatTokenForBrain(id)
  }
  return ''
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
