import { closeSync, openSync, readSync } from 'node:fs'
import {
  CHUNK_SIZE_DEFAULT,
  MEDIA_OPEN_FAIL,
  assertChunkSize,
  assertMediaId,
  chunkCountFor,
  cipherChunkSize,
  decryptChunk,
  encryptChunk,
  lastPlainSize,
  newDek,
  newNoncePrefix
} from './crypto.ts'

export const HEADER_BYTES = 64
export const MAGIC = Buffer.from('BRMEDIA1', 'ascii')
export const FORMAT_VERSION = 1

const OFF_MAGIC = 0
const OFF_VERSION = 8
const OFF_CHUNK_SIZE = 12
const OFF_NONCE = 16
const OFF_COUNT = 24
const OFF_PLAIN = 28
const OFF_RESERVED = 36

export type MediaHeader = {
  version: number
  chunkSize: number
  noncePrefix: Buffer
  chunkCount: number
  plainLen: number
}

export function encodeHeader(h: MediaHeader): Buffer {
  assertChunkSize(h.chunkSize)
  if (h.version !== FORMAT_VERSION) throw new Error(MEDIA_OPEN_FAIL)
  if (!Buffer.isBuffer(h.noncePrefix) || h.noncePrefix.length !== 8) throw new Error(MEDIA_OPEN_FAIL)
  if (!Number.isInteger(h.chunkCount) || h.chunkCount < 0) throw new Error(MEDIA_OPEN_FAIL)
  if (!Number.isInteger(h.plainLen) || h.plainLen < 0) throw new Error(MEDIA_OPEN_FAIL)
  const buf = Buffer.alloc(HEADER_BYTES)
  MAGIC.copy(buf, OFF_MAGIC)
  buf.writeUInt8(FORMAT_VERSION, OFF_VERSION)
  buf.writeUInt32BE(h.chunkSize, OFF_CHUNK_SIZE)
  h.noncePrefix.copy(buf, OFF_NONCE)
  buf.writeUInt32BE(h.chunkCount, OFF_COUNT)
  buf.writeBigUInt64BE(BigInt(h.plainLen), OFF_PLAIN)
  return buf
}

export function decodeHeader(buf: Buffer): MediaHeader {
  if (!Buffer.isBuffer(buf) || buf.length < HEADER_BYTES) throw new Error(MEDIA_OPEN_FAIL)
  const head = buf.subarray(0, HEADER_BYTES)
  if (!head.subarray(OFF_MAGIC, 8).equals(MAGIC)) throw new Error(MEDIA_OPEN_FAIL)
  const version = head.readUInt8(OFF_VERSION)
  if (version !== FORMAT_VERSION) throw new Error(MEDIA_OPEN_FAIL)
  if (head[9] !== 0 || head[10] !== 0 || head[11] !== 0) throw new Error(MEDIA_OPEN_FAIL)
  for (let i = OFF_RESERVED; i < HEADER_BYTES; i++) {
    if (head[i] !== 0) throw new Error(MEDIA_OPEN_FAIL)
  }
  const chunkSize = assertChunkSize(head.readUInt32BE(OFF_CHUNK_SIZE))
  const noncePrefix = Buffer.from(head.subarray(OFF_NONCE, OFF_NONCE + 8))
  const chunkCount = head.readUInt32BE(OFF_COUNT)
  const plainLenNum = head.readBigUInt64BE(OFF_PLAIN)
  if (plainLenNum > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(MEDIA_OPEN_FAIL)
  const plainLen = Number(plainLenNum)
  if (chunkCount !== chunkCountFor(plainLen, chunkSize)) throw new Error(MEDIA_OPEN_FAIL)
  return { version, chunkSize, noncePrefix, chunkCount, plainLen }
}

export function expectedObjectSize(h: MediaHeader): number {
  if (h.chunkCount === 0) return HEADER_BYTES
  const last = lastPlainSize(h.plainLen, h.chunkSize, h.chunkCount)
  return HEADER_BYTES + (h.chunkCount - 1) * cipherChunkSize(h.chunkSize) + cipherChunkSize(last)
}

export function encryptMedia(opts: {
  plaintext: Buffer
  mediaId: string
  chunkSize?: number
  dek?: Buffer
  noncePrefix?: Buffer
}): { object: Buffer; dek: Buffer; noncePrefix: Buffer; header: MediaHeader } {
  const mediaId = assertMediaId(opts.mediaId)
  const chunkSize = assertChunkSize(opts.chunkSize ?? CHUNK_SIZE_DEFAULT)
  const plaintext = opts.plaintext
  if (!Buffer.isBuffer(plaintext)) throw new Error(MEDIA_OPEN_FAIL)
  const dek = opts.dek && opts.dek.length ? opts.dek : newDek()
  const noncePrefix = opts.noncePrefix && opts.noncePrefix.length ? opts.noncePrefix : newNoncePrefix()
  const plainLen = plaintext.length
  const chunkCount = chunkCountFor(plainLen, chunkSize)
  const header: MediaHeader = { version: FORMAT_VERSION, chunkSize, noncePrefix, chunkCount, plainLen }
  const parts: Buffer[] = [encodeHeader(header)]
  for (let i = 0; i < chunkCount; i++) {
    const start = i * chunkSize
    const end = i === chunkCount - 1 ? plainLen : start + chunkSize
    const isLast = i === chunkCount - 1
    parts.push(
      encryptChunk({
        dek,
        prefix: noncePrefix,
        mediaId,
        chunkIndex: i,
        isLast,
        plaintext: plaintext.subarray(start, end)
      })
    )
  }
  return { object: Buffer.concat(parts), dek, noncePrefix, header }
}

export function decryptMedia(opts: { object: Buffer; mediaId: string; dek: Buffer }): Buffer {
  const mediaId = assertMediaId(opts.mediaId)
  const object = opts.object
  if (!Buffer.isBuffer(object)) throw new Error(MEDIA_OPEN_FAIL)
  const header = decodeHeader(object)
  const expect = expectedObjectSize(header)
  if (object.length !== expect) throw new Error(MEDIA_OPEN_FAIL)
  const out: Buffer[] = []
  let offset = HEADER_BYTES
  for (let i = 0; i < header.chunkCount; i++) {
    const isLast = i === header.chunkCount - 1
    const plainBytes = isLast ? lastPlainSize(header.plainLen, header.chunkSize, header.chunkCount) : header.chunkSize
    const take = cipherChunkSize(plainBytes)
    if (offset + take > object.length) throw new Error(MEDIA_OPEN_FAIL)
    out.push(
      decryptChunk({
        dek: opts.dek,
        prefix: header.noncePrefix,
        mediaId,
        chunkIndex: i,
        isLast,
        ciphertext: object.subarray(offset, offset + take)
      })
    )
    offset += take
  }
  const plain = Buffer.concat(out)
  if (plain.length !== header.plainLen) throw new Error(MEDIA_OPEN_FAIL)
  return plain
}

export function cipherChunkOffset(header: MediaHeader, chunkIndex: number): number {
  if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= header.chunkCount) {
    throw new Error(MEDIA_OPEN_FAIL)
  }
  return HEADER_BYTES + chunkIndex * cipherChunkSize(header.chunkSize)
}

export function plainBytesForChunk(header: MediaHeader, chunkIndex: number): number {
  if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= header.chunkCount) {
    throw new Error(MEDIA_OPEN_FAIL)
  }
  const isLast = chunkIndex === header.chunkCount - 1
  return isLast ? lastPlainSize(header.plainLen, header.chunkSize, header.chunkCount) : header.chunkSize
}

function decryptRangeWithRead(opts: {
  read: (offset: number, size: number) => Buffer
  mediaId: string
  dek: Buffer
  start: number
  end: number
}): Buffer {
  const mediaId = assertMediaId(opts.mediaId)
  const head = opts.read(0, HEADER_BYTES)
  const header = decodeHeader(head)
  if (!Number.isInteger(opts.start) || !Number.isInteger(opts.end) || opts.start < 0 || opts.end < opts.start) {
    throw new Error(MEDIA_OPEN_FAIL)
  }
  if (header.plainLen === 0) {
    if (opts.start === 0 && opts.end === -1) return Buffer.alloc(0)
    throw new Error(MEDIA_OPEN_FAIL)
  }
  if (opts.start >= header.plainLen) throw new Error(MEDIA_OPEN_FAIL)
  const end = Math.min(opts.end, header.plainLen - 1)
  const first = Math.floor(opts.start / header.chunkSize)
  const last = Math.floor(end / header.chunkSize)
  const parts: Buffer[] = []
  for (let i = first; i <= last; i++) {
    const isLast = i === header.chunkCount - 1
    const take = cipherChunkSize(plainBytesForChunk(header, i))
    const cipher = opts.read(cipherChunkOffset(header, i), take)
    if (!Buffer.isBuffer(cipher) || cipher.length !== take) throw new Error(MEDIA_OPEN_FAIL)
    parts.push(
      decryptChunk({
        dek: opts.dek,
        prefix: header.noncePrefix,
        mediaId,
        chunkIndex: i,
        isLast,
        ciphertext: cipher
      })
    )
  }
  const joined = Buffer.concat(parts)
  const sliceStart = opts.start - first * header.chunkSize
  const sliceEnd = sliceStart + (end - opts.start + 1)
  return joined.subarray(sliceStart, sliceEnd)
}

export function decryptRangeFromBuffer(opts: {
  object: Buffer
  mediaId: string
  dek: Buffer
  start: number
  end: number
}): Buffer {
  const object = opts.object
  if (!Buffer.isBuffer(object)) throw new Error(MEDIA_OPEN_FAIL)
  return decryptRangeWithRead({
    mediaId: opts.mediaId,
    dek: opts.dek,
    start: opts.start,
    end: opts.end,
    read: (offset, size) => {
      if (offset < 0 || size < 0 || offset + size > object.length) throw new Error(MEDIA_OPEN_FAIL)
      return object.subarray(offset, offset + size)
    }
  })
}

export function decryptRangeFromPath(opts: {
  path: string
  mediaId: string
  dek: Buffer
  start: number
  end: number
}): Buffer {
  const fd = openSync(opts.path, 'r')
  try {
    return decryptRangeWithRead({
      mediaId: opts.mediaId,
      dek: opts.dek,
      start: opts.start,
      end: opts.end,
      read: (offset, size) => {
        const buf = Buffer.alloc(size)
        const n = readSync(fd, buf, 0, size, offset)
        if (n !== size) throw new Error(MEDIA_OPEN_FAIL)
        return buf
      }
    })
  } finally {
    closeSync(fd)
  }
}
