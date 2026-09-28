/** HTTP bodies that match brain-sync media-v1 Slice 5 (origin/main 5c978b68). */

export const MEDIA_STATE_PATH = '/v1/media/state'
export const MEDIA_WRAPS_PATH = '/v1/media/wraps'
export const MEDIA_ROTATE_SCOPE_PATH = '/v1/media/rotate-scope'
export const MEDIA_DEVICES_PATH = '/v1/media/devices'
export const MEDIA_DOWNLOAD_PREFIX = '/v1/media/objects/'

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
