import { randomUUID } from 'node:crypto'
import { wrapDek, unwrapDek, wrapKeyToDevice, type DeviceKeyWrap } from './keys.ts'
import { mintedMatchesDevice, type MintedInvite } from './minted.ts'
import { rootsOverlap } from './hmac-seat.ts'
import {
  memoryMediaStore,
  type MediaBrainRow,
  type MediaDeviceRow,
  type MediaScopeRow,
  type MemoryMediaStore
} from './store.ts'
import { upsertWrap } from './wraps-file.ts'

export const NO_CAP = 'no_cap'
export const OVER_CAP = 'over_cap'
export const BUCKET_OFF = 'bucket_off'
export const ROTATION_PENDING = 'rotation_pending'
export const DEVICE_REVOKED = 'device_revoked'

export const REVOKE_COPY =
  "can't open new files here anymore. Copies he already opened stay deleted from his Mac once his app checks in. Anything he saved another way, we can't take back."
export const FINISH_REMOVE = 'Type your passphrase to finish removing'

export type ReserveResult = 'ok' | typeof NO_CAP | typeof OVER_CAP | typeof BUCKET_OFF | typeof ROTATION_PENDING

export function tryReserve(row: MediaBrainRow, cipherBytes: number): ReserveResult {
  if (row.brain_rotation_pending) return ROTATION_PENDING
  if (row.cap_bytes == null) return NO_CAP
  if (row.bucket_status !== 'on') return BUCKET_OFF
  const n = Number(cipherBytes)
  if (!Number.isInteger(n) || n < 0) return OVER_CAP
  if (row.used_bytes + row.reserved_bytes + n > row.cap_bytes) return OVER_CAP
  row.reserved_bytes += n
  return 'ok'
}

export function completeReservation(row: MediaBrainRow, cipherBytes: number): void {
  const n = Number(cipherBytes)
  if (n > 0) {
    row.reserved_bytes = Math.max(0, row.reserved_bytes - n)
    row.used_bytes += n
  }
}

export function releaseReservation(row: MediaBrainRow, cipherBytes: number): void {
  const n = Number(cipherBytes)
  if (n > 0) row.reserved_bytes = Math.max(0, row.reserved_bytes - n)
}

export function projectLabel(roots: string[] | undefined): string {
  const root = String(roots?.[0] || '')
  const m = /^(?:projects|clients)\/([^/]+)\//.exec(root)
  return m ? m[1].replace(/-/g, ' ') : 'brain'
}

export function revokeCopy(email: string): string {
  const name = String(email || '').split('@')[0] || 'That person'
  const pretty = name.charAt(0).toUpperCase() + name.slice(1)
  return `${pretty} ${REVOKE_COPY}`
}

export function finishRemoveCopy(email: string): string {
  const name = String(email || '').split('@')[0] || 'that person'
  return `${FINISH_REMOVE} ${name}.`
}

function wrapToHex(w: DeviceKeyWrap): { eph_pub: string; nonce: string; ciphertext: string } {
  return {
    eph_pub: w.ephPub.toString('hex'),
    nonce: w.nonce.toString('hex'),
    ciphertext: w.ciphertext.toString('hex')
  }
}

function deviceCoversScope(device: MediaDeviceRow, scope: MediaScopeRow): boolean {
  if (device.seat_kind !== 'project') return true
  return rootsOverlap(device.roots || [], scope.root)
}

export function pushDeviceWrap(opts: {
  mem: MemoryMediaStore
  row: MediaBrainRow
  device: MediaDeviceRow
  scope: string
  version: number
  key: Buffer
  userData?: string
}): void {
  const pub = Buffer.from(String(opts.device.public_key || ''), 'hex')
  if (pub.length !== 32) return
  const packed = wrapToHex(
    wrapKeyToDevice({
      key: opts.key,
      devicePublicKey: pub,
      mediaBrainId: opts.row.id,
      scope: opts.scope,
      version: opts.version
    })
  )
  opts.mem.wraps = opts.mem.wraps.filter(
    (w) =>
      !(
        w.media_brain_id === opts.row.id &&
        w.scope === opts.scope &&
        w.key_version === opts.version &&
        w.device_id === opts.device.id
      )
  )
  opts.mem.wraps.push({
    id: randomUUID(),
    media_brain_id: opts.row.id,
    scope: opts.scope,
    key_version: opts.version,
    target: 'device',
    device_id: opts.device.id,
    eph_pub: packed.eph_pub,
    nonce: packed.nonce,
    ciphertext: packed.ciphertext
  })
  if (opts.userData) {
    upsertWrap(opts.userData, opts.row.id, {
      scope: opts.scope,
      key_version: opts.version,
      eph_pub: packed.eph_pub,
      nonce: packed.nonce,
      ciphertext: packed.ciphertext
    })
  }
}

export function wrapScopesToDevice(opts: {
  mem: MemoryMediaStore
  row: MediaBrainRow
  device: MediaDeviceRow
  scopeKeys: Map<string, Buffer>
  userData?: string
}): void {
  for (const scope of opts.mem.scopes.filter((s) => s.media_brain_id === opts.row.id)) {
    if (!deviceCoversScope(opts.device, scope)) continue
    const key = opts.scopeKeys.get(scope.id)
    if (!key) continue
    pushDeviceWrap({
      mem: opts.mem,
      row: opts.row,
      device: opts.device,
      scope: scope.id,
      version: scope.key_version,
      key,
      userData: opts.userData
    })
  }
}

export function autoWrapPending(opts: {
  mem: MemoryMediaStore
  row: MediaBrainRow
  minted: MintedInvite[]
  scopeKeys: Map<string, Buffer>
}): string[] {
  const wrapped: string[] = []
  for (const device of opts.mem.devices.filter(
    (d) => d.media_brain_id === opts.row.id && d.status === 'pending'
  )) {
    if (!mintedMatchesDevice(opts.minted, device.email, device.roots || [])) continue
    wrapScopesToDevice({
      mem: opts.mem,
      row: opts.row,
      device,
      scopeKeys: opts.scopeKeys
    })
    device.status = 'approved'
    wrapped.push(device.id)
  }
  return wrapped
}

export function pullDeviceWraps(userData: string, mediaBrainId: string, deviceId: string): number {
  const mem = memoryMediaStore(userData)
  let n = 0
  for (const w of mem.wraps.filter(
    (row) => row.media_brain_id === mediaBrainId && row.device_id === deviceId
  )) {
    upsertWrap(userData, mediaBrainId, {
      scope: w.scope,
      key_version: w.key_version,
      eph_pub: w.eph_pub,
      nonce: w.nonce,
      ciphertext: w.ciphertext
    })
    n += 1
  }
  return n
}

export function rotateProjectScope(opts: {
  mem: MemoryMediaStore
  row: MediaBrainRow
  scope: MediaScopeRow
  oldKey: Buffer
  newKey: Buffer
  keepDevices: MediaDeviceRow[]
  ownerUserData?: string
  ownerDeviceId?: string
}): number {
  const oldVersion = opts.scope.key_version
  const next = oldVersion + 1
  for (const object of opts.mem.objects.filter(
    (o) => o.media_brain_id === opts.row.id && o.scope_id === opts.scope.id && o.status !== 'deleted'
  )) {
    const dek = unwrapDek({
      wrap: Buffer.from(object.dek_wrap, 'hex'),
      projectKey: opts.oldKey,
      mediaId: object.id,
      scopeId: opts.scope.id,
      keyVersion: object.dek_version
    })
    object.dek_wrap = wrapDek({
      dek,
      projectKey: opts.newKey,
      mediaId: object.id,
      scopeId: opts.scope.id,
      keyVersion: next
    }).toString('hex')
    object.dek_version = next
    dek.fill(0)
  }
  opts.scope.key_version = next
  opts.scope.needs_rotation = false
  opts.mem.wraps = opts.mem.wraps.filter(
    (w) => !(w.media_brain_id === opts.row.id && w.scope === opts.scope.id && w.key_version === oldVersion)
  )
  for (const device of opts.keepDevices) {
    if (device.status !== 'approved') continue
    if (!deviceCoversScope(device, opts.scope)) continue
    const local = opts.ownerUserData && device.id === opts.ownerDeviceId ? opts.ownerUserData : undefined
    pushDeviceWrap({
      mem: opts.mem,
      row: opts.row,
      device,
      scope: opts.scope.id,
      version: next,
      key: opts.newKey,
      userData: local
    })
  }
  return next
}

export function markMediaRevoked(opts: {
  mem: MemoryMediaStore
  mediaBrainId: string
  email: string
  roots?: string[]
  proof?: boolean
}): { kind: 'project' | 'blocked' | 'wiped'; detail: string } {
  const email = String(opts.email || '')
    .trim()
    .toLowerCase()
  const row = opts.mem.brains.find((b) => b.id === opts.mediaBrainId)
  if (!row) return { kind: 'blocked', detail: finishRemoveCopy(email) }
  const devices = opts.mem.devices.filter(
    (d) => d.media_brain_id === row.id && d.email.toLowerCase() === email
  )
  const project =
    devices.length > 0 && devices.every((d) => d.seat_kind === 'project')
      ? true
      : Boolean(opts.roots && opts.roots.length)
  if (project) {
    for (const device of devices) {
      opts.mem.wraps = opts.mem.wraps.filter(
        (w) => !(w.media_brain_id === row.id && w.device_id === device.id)
      )
      device.status = 'revoked'
      for (const root of device.roots || opts.roots || []) {
        const scope = opts.mem.scopes.find((s) => s.media_brain_id === row.id && s.root === root)
        if (scope) scope.needs_rotation = true
      }
    }
    const seats = opts.mem.seats.filter((s) => s.media_brain_id === row.id && s.email.toLowerCase() === email)
    for (const seat of seats) seat.status = 'revoked'
    return { kind: 'project', detail: revokeCopy(email) }
  }
  if (!opts.proof) {
    for (const device of devices) device.status = 'blocked'
    row.brain_rotation_pending = email
    return { kind: 'blocked', detail: finishRemoveCopy(email) }
  }
  for (const device of devices) {
    opts.mem.wraps = opts.mem.wraps.filter(
      (w) => !(w.media_brain_id === row.id && w.device_id === device.id)
    )
    device.status = 'revoked'
  }
  return { kind: 'wiped', detail: revokeCopy(email) }
}

export function workerStateForDevice(device: MediaDeviceRow | undefined): {
  status: number
  error?: string
} {
  if (!device) return { status: 204 }
  if (device.status === 'revoked') return { status: 410, error: DEVICE_REVOKED }
  if (device.status === 'blocked') return { status: 401 }
  return { status: 200 }
}
