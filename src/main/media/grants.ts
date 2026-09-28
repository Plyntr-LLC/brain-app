import { randomUUID } from 'node:crypto'
import {
  createBrainKey,
  createRecoveryKey,
  createScopeKey,
  wrapBrainKeyWithPassphrase,
  wrapBrainKeyWithRecovery,
  wrapDek,
  unwrapDek,
  wrapKeyToDevice,
  wrapKeyWithBrain,
  type DeviceKeyWrap
} from './keys.ts'
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
import {
  mediaErrorBody,
  rotateDeviceWrap,
  type DeviceWrapBody,
  type RotateDekWrap,
  type RotateDeviceWrap,
  type RotateScopeBody
} from './worker-shapes.ts'

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

export function wrapPostBody(opts: {
  deviceId: string
  scope: string
  keyVersion: number
  eph_pub: string
  nonce: string
  ciphertext: string
}): DeviceWrapBody {
  return {
    device_id: opts.deviceId,
    scope: opts.scope,
    key_version: opts.keyVersion,
    eph_pub: opts.eph_pub,
    nonce: opts.nonce,
    ciphertext: opts.ciphertext
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
}): DeviceWrapBody | null {
  const pub = Buffer.from(String(opts.device.public_key || ''), 'hex')
  if (pub.length !== 32) return null
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
  return wrapPostBody({
    deviceId: opts.device.id,
    scope: opts.scope,
    keyVersion: opts.version,
    eph_pub: packed.eph_pub,
    nonce: packed.nonce,
    ciphertext: packed.ciphertext
  })
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
  brainKey?: Buffer
}): { to_version: number; post: RotateScopeBody } {
  const oldVersion = opts.scope.key_version
  const next = oldVersion + 1
  const dekWraps: RotateDekWrap[] = []
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
    dekWraps.push({ objectId: object.id, dekWrap: object.dek_wrap, dekVersion: next })
    dek.fill(0)
  }
  opts.scope.key_version = next
  opts.scope.needs_rotation = false
  opts.mem.wraps = opts.mem.wraps.filter(
    (w) => !(w.media_brain_id === opts.row.id && w.scope === opts.scope.id && w.key_version === oldVersion)
  )
  const wraps: RotateDeviceWrap[] = []
  for (const device of opts.keepDevices) {
    if (device.status !== 'approved') continue
    if (!deviceCoversScope(device, opts.scope)) continue
    const local = opts.ownerUserData && device.id === opts.ownerDeviceId ? opts.ownerUserData : undefined
    const body = pushDeviceWrap({
      mem: opts.mem,
      row: opts.row,
      device,
      scope: opts.scope.id,
      version: next,
      key: opts.newKey,
      userData: local
    })
    if (body) wraps.push(rotateDeviceWrap(body))
  }
  if (opts.brainKey) {
    const sealed = wrapKeyWithBrain({
      key: opts.newKey,
      brainKey: opts.brainKey,
      mediaBrainId: opts.row.id,
      scope: opts.scope.id,
      version: next
    })
    opts.mem.wraps.push({
      id: randomUUID(),
      media_brain_id: opts.row.id,
      scope: opts.scope.id,
      key_version: next,
      target: 'brain',
      device_id: '',
      eph_pub: '',
      nonce: '',
      ciphertext: sealed.toString('hex')
    })
  }
  return {
    to_version: next,
    post: {
      scopeId: opts.scope.id,
      keyVersion: oldVersion,
      dekWraps,
      wraps
    }
  }
}

export function rotateFullBrain(opts: {
  mem: MemoryMediaStore
  row: MediaBrainRow
  passphrase: string
  scopeKeys: Map<string, Buffer>
  keepDevices: MediaDeviceRow[]
  ownerUserData?: string
  ownerDeviceId?: string
}): { brainKey: Buffer; recoveryDisplay: string } {
  const oldBrainVersion = opts.row.brain_key_version
  const nextBrain = oldBrainVersion + 1
  const newBrainKey = createBrainKey()
  const recovery = createRecoveryKey()
  const keep = opts.keepDevices.filter((d) => d.status === 'approved')
  for (const scope of opts.mem.scopes.filter((s) => s.media_brain_id === opts.row.id)) {
    const oldKey = opts.scopeKeys.get(scope.id)
    if (!oldKey) continue
    const newKey = createScopeKey()
    rotateProjectScope({
      mem: opts.mem,
      row: opts.row,
      scope,
      oldKey,
      newKey,
      keepDevices: keep,
      ownerUserData: opts.ownerUserData,
      ownerDeviceId: opts.ownerDeviceId,
      brainKey: newBrainKey
    })
    opts.scopeKeys.set(scope.id, newKey)
  }
  opts.row.brain_key_version = nextBrain
  const passWrap = wrapBrainKeyWithPassphrase({
    brainKey: newBrainKey,
    passphrase: opts.passphrase,
    mediaBrainId: opts.row.id
  })
  const recWrap = wrapBrainKeyWithRecovery({
    brainKey: newBrainKey,
    recoveryKey: recovery.raw,
    mediaBrainId: opts.row.id
  })
  opts.row.passphrase_wrap = passWrap.wrap.toString('hex')
  opts.row.passphrase_salt = passWrap.salt.toString('hex')
  opts.row.passphrase_proof = passWrap.proofPublicKey.toString('hex')
  opts.row.recovery_wrap = recWrap.wrap.toString('hex')
  opts.row.recovery_proof = recWrap.proofPublicKey.toString('hex')
  opts.row.brain_rotation_pending = ''
  opts.mem.wraps = opts.mem.wraps.filter(
    (w) => !(w.media_brain_id === opts.row.id && w.scope === 'brain' && w.key_version === oldBrainVersion)
  )
  for (const device of keep) {
    if (device.seat_kind === 'project') continue
    pushDeviceWrap({
      mem: opts.mem,
      row: opts.row,
      device,
      scope: 'brain',
      version: nextBrain,
      key: newBrainKey,
      userData: opts.ownerUserData && device.id === opts.ownerDeviceId ? opts.ownerUserData : undefined
    })
  }
  return { brainKey: newBrainKey, recoveryDisplay: recovery.display }
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

/** Worker contract: markMediaRevoked(email, brain, roots?, proof) in media-v1.js */
export function markMediaRevokedWorker(
  email: string,
  brain: MediaBrainRow,
  roots?: string[],
  proof?: boolean
): { kind: 'project' | 'blocked' | 'wiped'; detail: string } {
  return markMediaRevoked({
    mem: memoryMediaStore(brain.user_data || ''),
    mediaBrainId: brain.id,
    email,
    roots,
    proof
  })
}

export function workerStateForDevice(device: MediaDeviceRow | undefined): {
  status: number
  error?: string
  body?: { error: string }
} {
  if (!device) return { status: 204 }
  if (device.status === 'revoked') {
    const body = mediaErrorBody(DEVICE_REVOKED)
    return { status: 410, error: body.error, body }
  }
  if (device.status === 'blocked') return { status: 401 }
  return { status: 200 }
}
