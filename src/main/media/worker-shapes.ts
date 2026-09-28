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

export type RotateScopeBody = {
  scope_id: string
  from_version: number
  to_version: number
  dek_wraps: Array<{ object_id: string; dek_wrap: string; dek_version: number }>
  wraps: DeviceWrapBody[]
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
