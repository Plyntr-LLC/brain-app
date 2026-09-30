/** HTTP bodies that match brain-sync media-v1 Slice 6 (tip MEDIA_V1_TIP in transport.ts). */

import { createHash } from 'node:crypto'

export const MEDIA_STATE_PATH = '/v1/media/state'
export const MEDIA_WRAPS_PATH = '/v1/media/wraps'
export const MEDIA_ROTATE_SCOPE_PATH = '/v1/media/rotate-scope'
export const MEDIA_DEVICES_PATH = '/v1/media/devices'
export const MEDIA_DOWNLOAD_PREFIX = '/v1/media/objects/'
export const MEDIA_CODES_EMAIL_PATH = '/v1/media/codes/email'
export const MEDIA_BRAINS_PATH = '/v1/media/brains'
export const MEDIA_INVITES_PATH = '/v1/media/invites'
export const MEDIA_INVITES_REDEEM_PATH = '/v1/media/invites/redeem'
export const MEDIA_RECLAIM_START_PATH = '/v1/media/reclaim/start'
export const MEDIA_RECLAIM_FINISH_PATH = '/v1/media/reclaim/finish'
export const MEDIA_WRAP_PASSPHRASE_PATH = '/v1/media/wrap/passphrase'
export const MEDIA_ROTATE_PATH = '/v1/media/rotate'
export const MEDIA_SCOPES_PATH = '/v1/media/scopes'
export const MEDIA_UPLOADS_PATH = '/v1/media/uploads'
export const MEDIA_OBJECTS_PATH = '/v1/media/objects'

export type MediaErrorBody = {
  error: string
}

export type DeviceWrapBody = {
  device_id: string
  scope: string
  key_version: number
  eph_pub: string
  nonce: string
  ciphertext: string
}

/** POST /v1/media/rotate-scope. Worker reads camelCase (objectId or id). */
export type RotateDekWrap = {
  objectId: string
  dekWrap: string
  dekVersion: number
}

export type RotateDeviceWrap = {
  deviceId: string
  ephPub: string
  nonce: string
  ciphertext: string
}

export type RotateScopeBody = {
  scopeId: string
  keyVersion: number
  dekWraps: RotateDekWrap[]
  wraps: RotateDeviceWrap[]
}

export function rotateDeviceWrap(body: DeviceWrapBody): RotateDeviceWrap {
  return {
    deviceId: body.device_id,
    ephPub: body.eph_pub,
    nonce: body.nonce,
    ciphertext: body.ciphertext
  }
}

export type MediaStateOk = {
  brain_key_version: number
  wraps: DeviceWrapBody[]
  scopes: Array<{ id: string; root: string; key_version: number; needs_rotation: boolean }>
}

export function mediaErrorBody(error: string): MediaErrorBody {
  return { error: String(error || '') }
}

export function isDeviceRevokedBody(body: unknown): boolean {
  return Boolean(body && typeof body === 'object' && (body as MediaErrorBody).error === 'device_revoked')
}

export type CodesEmailBody = {
  email: string
}

export type ClaimBrainBody = {
  email: string
  code: string
}

export type MediaInviteBody = {
  email: string
  role?: string
  roots?: string[]
}

export type MediaInviteRedeemBody = {
  email: string
  code: string
}

export type ReclaimStartBody = {
  email: string
  code: string
  device_public_key: string
  media_brain_id?: string
}

export type ReclaimStartOk = {
  salt: string
  N: number
  r: number
  p: number
  passphrase_wrap: string
  recovery_wrap: string
  challenge: string
  token: string
  media_brain_id: string
  brain_key_version: number
}

export type ReclaimFinishBody = {
  token: string
  signature: string
  kind: 'passphrase' | 'recovery'
  device_public_key: string
  wrap?: { eph_pub: string; nonce: string; ciphertext: string }
  scope_wraps?: Array<{ scope: string; key_version: number; eph_pub: string; nonce: string; ciphertext: string }>
}

export type WrapPassphraseBody = {
  signature: string
  kind: 'passphrase' | 'recovery'
  wrap: string
  proof_public_key: string
  salt: string
  N: number
  r: number
  p: number
}

export function reclaimStartHasSecrets(body: unknown): boolean {
  const raw = JSON.stringify(body || {})
  return /\bpbt_|\bpms_|X-Amz-|BEGIN [A-Z ]*PRIVATE|r2\.cloudflarestorage\.com|https?:\/\/[^\s"]*download/i.test(raw)
}

/** Signed bytes for a proof route: challenge, action, then sha256 of the body minus signature and challengeId, top-level keys sorted. */
export function wrapProofMessage(challenge: Buffer, action: string, body: Record<string, unknown>): Buffer {
  const sorted: Record<string, unknown> = {}
  for (const k of Object.keys(body).filter((k) => k !== 'signature' && k !== 'challengeId').sort()) sorted[k] = body[k]
  const hash = createHash('sha256').update(JSON.stringify(sorted)).digest()
  return Buffer.concat([challenge, Buffer.from(action), hash])
}
