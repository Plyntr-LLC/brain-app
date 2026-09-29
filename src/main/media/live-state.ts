import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { MediaBrainRow } from './store.ts'

export type LiveSnap = {
  mediaBrainId: string
  deviceId: string
  bucket: string
  folder: string
  bucketStatus: 'off' | 'on'
  capBytes: number | null
  usedBytes: number
  brainKeyVersion?: number
}

function assertId(id: string): string {
  const s = String(id || '')
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(s)) throw new Error('Bad media brain id.')
  return s
}

export function liveSnapPath(userData: string, mediaBrainId: string): string {
  return join(userData, 'media', assertId(mediaBrainId), 'live.json')
}

export function readLiveSnap(userData: string, mediaBrainId: string): LiveSnap | null {
  const path = liveSnapPath(userData, mediaBrainId)
  if (!existsSync(path)) return null
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as LiveSnap
    if (!raw || raw.mediaBrainId !== mediaBrainId) return null
    return raw
  } catch {
    return null
  }
}

export function writeLiveSnap(userData: string, snap: LiveSnap): void {
  const path = liveSnapPath(userData, snap.mediaBrainId)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(snap)}\n`)
}

/** A Mac that joined without media.json (a project folder) finds its brain by the folder it joined from. */
export function liveSnapForFolder(userData: string, folder: string): LiveSnap | null {
  const want = String(folder || '')
  if (!want) return null
  let names: string[] = []
  try {
    names = readdirSync(join(userData, 'media'))
  } catch {
    return null
  }
  for (const name of names) {
    if (!/^[A-Za-z0-9_-]{8,80}$/.test(name)) continue
    const snap = readLiveSnap(userData, name)
    if (snap?.folder === want && snap.deviceId) return snap
  }
  return null
}

export function rowFromLiveSnap(snap: LiveSnap, userData: string): MediaBrainRow {
  return {
    id: snap.mediaBrainId,
    plyntr_brain_id: '',
    hq_repo: '',
    folder: snap.folder,
    bucket: snap.bucket,
    bucket_status: snap.bucketStatus,
    cap_bytes: snap.capBytes,
    used_bytes: snap.usedBytes,
    reserved_bytes: 0,
    brain_key_version: snap.brainKeyVersion || 1,
    brain_rotation_pending: '',
    recovery_wrap: '',
    passphrase_wrap: '',
    passphrase_salt: '',
    passphrase_proof: '',
    recovery_proof: '',
    created_by_email: '',
    status: 'on',
    user_data: userData
  }
}
