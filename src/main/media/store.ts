export type MediaBrainRow = {
  id: string
  plyntr_brain_id: string
  folder: string
  bucket: string
  bucket_status: 'off' | 'on'
  cap_bytes: number | null
  used_bytes: number
  reserved_bytes: number
  brain_key_version: number
  brain_rotation_pending: string
  recovery_wrap: string
  passphrase_wrap: string
  passphrase_salt: string
  passphrase_proof: string
  recovery_proof: string
  created_by_email: string
  status: string
  user_data: string
}

export type MediaWrapRow = {
  id: string
  media_brain_id: string
  scope: string
  key_version: number
  target: 'device' | 'brain' | 'passphrase' | 'recovery'
  device_id: string
  eph_pub: string
  nonce: string
  ciphertext: string
}

export type MediaObjectRow = {
  id: string
  media_brain_id: string
  scope_id: string
  object_key: string
  bytes: number
  cipher_bytes: number
  mime: string
  dek_wrap: string
  dek_version: number
  status: 'uploading' | 'ready' | 'deleted'
  upload_id: string
  part_count: number
  created_by_email: string
}

export type MediaDeviceRow = {
  id: string
  media_brain_id: string
  email: string
  fingerprint: string
  public_key: string
  seat_kind: 'full' | 'project'
  seat_id: string
  roots: string[]
  status: 'approved' | 'pending' | 'blocked' | 'revoked'
}

export type MediaScopeRow = {
  id: string
  media_brain_id: string
  root: string
  key_version: number
  escrow_wrap: string
  needs_rotation: boolean
}

export type MediaSeatRow = {
  id: string
  media_brain_id: string
  email: string
  role: string
  roots: string[]
  status: string
}

export type MemoryMediaStore = {
  brains: MediaBrainRow[]
  wraps: MediaWrapRow[]
  objects: MediaObjectRow[]
  devices: MediaDeviceRow[]
  scopes: MediaScopeRow[]
  seats: MediaSeatRow[]
}

const DRY_WORKER = '__dry_worker__'
const stores = new Map<string, MemoryMediaStore>()

function empty(): MemoryMediaStore {
  return { brains: [], wraps: [], objects: [], devices: [], scopes: [], seats: [] }
}

function storeKey(userData: string): string {
  if (process.env.BRAIN_APP_DRY_RUN === '1') return DRY_WORKER
  return String(userData || '')
}

export function memoryMediaStore(userData: string): MemoryMediaStore {
  const key = storeKey(userData)
  let hit = stores.get(key)
  if (!hit) {
    hit = empty()
    stores.set(key, hit)
  }
  return hit
}

export function resetMemoryMediaStore(userData?: string): void {
  if (userData) {
    stores.delete(String(userData))
    stores.delete(DRY_WORKER)
  } else stores.clear()
}

export function dumpMemoryMediaStore(userData: string): MemoryMediaStore {
  const src = memoryMediaStore(userData)
  return JSON.parse(JSON.stringify(src)) as MemoryMediaStore
}
