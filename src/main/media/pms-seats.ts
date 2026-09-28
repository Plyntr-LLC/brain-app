import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { SafeStorageApi } from './device-key.ts'

export const PMS_SEATS_FILE = 'seats.json'
export const PMS_PREFIX = 'pms_'

export type StoredPmsSeat = {
  email: string
  role: string
  token: string
  mediaBrainId: string
}

type FileSeat = {
  email: string
  role: string
  token: string
}

type FileShape = {
  version: 1
  seats: Record<string, FileSeat>
}

export function pmsSeatsPath(userData: string): string {
  return join(userData, 'media', PMS_SEATS_FILE)
}

function emptyFile(): FileShape {
  return { version: 1, seats: {} }
}

function readFile(userData: string): FileShape {
  const path = pmsSeatsPath(userData)
  if (!existsSync(path)) return emptyFile()
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as FileShape
    if (!raw || raw.version !== 1 || !raw.seats || typeof raw.seats !== 'object') return emptyFile()
    return raw
  } catch {
    return emptyFile()
  }
}

function writeFile(userData: string, data: FileShape): void {
  const path = pmsSeatsPath(userData)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(data))
}

function sealToken(token: string, safe: SafeStorageApi): string {
  return safe.encryptString(token).toString('base64')
}

function unsealToken(sealed: string, safe: SafeStorageApi): string | null {
  try {
    return safe.decryptString(Buffer.from(sealed, 'base64'))
  } catch {
    return null
  }
}

export function mintPmsToken(): string {
  return `${PMS_PREFIX}${randomBytes(18).toString('hex')}`
}

export function writePmsSeat(userData: string, seat: StoredPmsSeat, safe: SafeStorageApi): void {
  const id = String(seat.mediaBrainId || '')
  if (!id) return
  const data = readFile(userData)
  data.seats[id] = {
    email: String(seat.email || '').trim().toLowerCase(),
    role: String(seat.role || 'owner'),
    token: sealToken(seat.token, safe)
  }
  writeFile(userData, data)
}

export function readPmsSeat(userData: string, mediaBrainId: string, safe: SafeStorageApi): StoredPmsSeat | null {
  const id = String(mediaBrainId || '')
  if (!id) return null
  const row = readFile(userData).seats[id]
  if (!row) return null
  const token = unsealToken(row.token, safe)
  if (!token || !token.startsWith(PMS_PREFIX)) return null
  return {
    email: row.email,
    role: row.role,
    token,
    mediaBrainId: id
  }
}

export function readAnyPmsSeat(userData: string, safe: SafeStorageApi): StoredPmsSeat | null {
  const data = readFile(userData)
  for (const id of Object.keys(data.seats)) {
    const hit = readPmsSeat(userData, id, safe)
    if (hit) return hit
  }
  return null
}

export function dropPmsSeat(userData: string, mediaBrainId: string): void {
  const id = String(mediaBrainId || '')
  if (!id) return
  const data = readFile(userData)
  if (!(id in data.seats)) return
  delete data.seats[id]
  writeFile(userData, data)
}
