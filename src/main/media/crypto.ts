import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

export const CHUNK_SIZE_DEFAULT = 4 * 1024 * 1024
export const CHUNK_SIZE_MIN = 64 * 1024
export const GCM_TAG_BYTES = 16
export const NONCE_PREFIX_BYTES = 8
export const CHUNK_NONCE_BYTES = 12
export const DEK_BYTES = 32

export const MEDIA_OPEN_FAIL = 'This file could not be opened.'

export function assertChunkSize(chunkSize: number): number {
  const n = Number(chunkSize)
  if (!Number.isInteger(n) || n < CHUNK_SIZE_MIN || n > CHUNK_SIZE_DEFAULT) {
    throw new Error(MEDIA_OPEN_FAIL)
  }
  return n
}

export function assertMediaId(mediaId: string): string {
  const id = String(mediaId || '')
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw new Error(MEDIA_OPEN_FAIL)
  }
  return id
}

export function newDek(): Buffer {
  return randomBytes(DEK_BYTES)
}

export function newNoncePrefix(): Buffer {
  return randomBytes(NONCE_PREFIX_BYTES)
}

export function chunkNonce(prefix: Buffer, chunkIndex: number): Buffer {
  if (!Buffer.isBuffer(prefix) || prefix.length !== NONCE_PREFIX_BYTES) throw new Error(MEDIA_OPEN_FAIL)
  if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex > 0xffffffff) throw new Error(MEDIA_OPEN_FAIL)
  const nonce = Buffer.alloc(CHUNK_NONCE_BYTES)
  prefix.copy(nonce, 0, 0, NONCE_PREFIX_BYTES)
  nonce.writeUInt32BE(chunkIndex >>> 0, NONCE_PREFIX_BYTES)
  return nonce
}

export function chunkAad(mediaId: string, chunkIndex: number, isLast: boolean): Buffer {
  return Buffer.from(`${assertMediaId(mediaId)}|${chunkIndex}|${isLast ? '1' : '0'}`, 'utf8')
}

export function encryptChunk(opts: {
  dek: Buffer
  prefix: Buffer
  mediaId: string
  chunkIndex: number
  isLast: boolean
  plaintext: Buffer
}): Buffer {
  const nonce = chunkNonce(opts.prefix, opts.chunkIndex)
  const cipher = createCipheriv('aes-256-gcm', opts.dek, nonce)
  cipher.setAAD(chunkAad(opts.mediaId, opts.chunkIndex, opts.isLast))
  const body = Buffer.concat([cipher.update(opts.plaintext), cipher.final()])
  return Buffer.concat([body, cipher.getAuthTag()])
}

export function decryptChunk(opts: {
  dek: Buffer
  prefix: Buffer
  mediaId: string
  chunkIndex: number
  isLast: boolean
  ciphertext: Buffer
}): Buffer {
  const buf = opts.ciphertext
  if (!Buffer.isBuffer(buf) || buf.length < GCM_TAG_BYTES) throw new Error(MEDIA_OPEN_FAIL)
  const tag = buf.subarray(buf.length - GCM_TAG_BYTES)
  const body = buf.subarray(0, buf.length - GCM_TAG_BYTES)
  try {
    const nonce = chunkNonce(opts.prefix, opts.chunkIndex)
    const decipher = createDecipheriv('aes-256-gcm', opts.dek, nonce)
    decipher.setAAD(chunkAad(opts.mediaId, opts.chunkIndex, opts.isLast))
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(body), decipher.final()])
  } catch {
    throw new Error(MEDIA_OPEN_FAIL)
  }
}

export function chunkCountFor(plainLen: number, chunkSize: number): number {
  if (plainLen === 0) return 0
  return Math.ceil(plainLen / chunkSize)
}

export function lastPlainSize(plainLen: number, chunkSize: number, chunkCount: number): number {
  if (chunkCount === 0) return 0
  const full = chunkCount - 1
  return plainLen - full * chunkSize
}

export function cipherChunkSize(plainBytes: number): number {
  return plainBytes + GCM_TAG_BYTES
}
