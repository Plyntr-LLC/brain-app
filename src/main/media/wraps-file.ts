import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export type DiskWrap = {
  scope: string
  key_version: number
  eph_pub: string
  nonce: string
  ciphertext: string
}

function assertBrainId(id: string): string {
  const s = String(id || '')
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(s)) throw new Error('Bad media brain id.')
  return s
}

export function wrapsFilePath(userData: string, mediaBrainId: string): string {
  return join(userData, 'media', assertBrainId(mediaBrainId), 'wraps.json')
}

export function readWrapsFile(userData: string, mediaBrainId: string): DiskWrap[] {
  const path = wrapsFilePath(userData, mediaBrainId)
  if (!existsSync(path)) return []
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { wraps?: DiskWrap[] }
    return Array.isArray(raw.wraps) ? raw.wraps : []
  } catch {
    return []
  }
}

export function upsertWrap(userData: string, mediaBrainId: string, wrap: DiskWrap): void {
  const path = wrapsFilePath(userData, mediaBrainId)
  mkdirSync(dirname(path), { recursive: true })
  const wraps = readWrapsFile(userData, mediaBrainId).filter(
    (w) => !(w.scope === wrap.scope && w.key_version === wrap.key_version)
  )
  wraps.push({
    scope: String(wrap.scope),
    key_version: Number(wrap.key_version),
    eph_pub: String(wrap.eph_pub),
    nonce: String(wrap.nonce),
    ciphertext: String(wrap.ciphertext)
  })
  writeFileSync(path, JSON.stringify({ wraps }))
}
