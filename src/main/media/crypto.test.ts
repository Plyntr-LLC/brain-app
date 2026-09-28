import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import {
  CHUNK_SIZE_MIN,
  GCM_TAG_BYTES,
  MEDIA_OPEN_FAIL,
  cipherChunkSize,
  decryptChunk,
  encryptChunk,
  newDek,
  newNoncePrefix
} from './crypto.ts'
import { HEADER_BYTES, MAGIC, decryptMedia, encryptMedia, expectedObjectSize } from './format.ts'

const CHUNK = CHUNK_SIZE_MIN

function fiveChunkPlain(): { mediaId: string; plain: Buffer } {
  const mediaId = randomUUID()
  const plain = Buffer.alloc(CHUNK * 5, 0)
  plain.write('PLAINTEXT-MARKER-7f3c', 100)
  for (let i = 0; i < 5; i++) plain.writeUInt32BE(i + 1, i * CHUNK)
  return { mediaId, plain }
}

test('encrypt then decrypt matches for five 64 KiB chunks', () => {
  const { mediaId, plain } = fiveChunkPlain()
  const out = encryptMedia({ plaintext: plain, mediaId, chunkSize: CHUNK })
  assert.equal(out.header.chunkCount, 5)
  assert.equal(out.header.chunkSize, CHUNK)
  assert.equal(out.object.subarray(0, 8).equals(MAGIC), true)
  assert.equal(out.object.length, expectedObjectSize(out.header))
  const back = decryptMedia({ object: out.object, mediaId, dek: out.dek })
  assert.equal(Buffer.compare(back, plain), 0)
  assert.equal(out.object.includes('PLAINTEXT-MARKER-7f3c'), false)
})

test('a flipped ciphertext byte fails the GCM tag', () => {
  const { mediaId, plain } = fiveChunkPlain()
  const out = encryptMedia({ plaintext: plain, mediaId, chunkSize: CHUNK })
  const tampered = Buffer.from(out.object)
  tampered[HEADER_BYTES] = tampered[HEADER_BYTES] ^ 0xff
  assert.throws(() => decryptMedia({ object: tampered, mediaId, dek: out.dek }), (err: Error) => {
    assert.equal(err.message, MEDIA_OPEN_FAIL)
    return true
  })
})

test('a missing last chunk fails', () => {
  const { mediaId, plain } = fiveChunkPlain()
  const out = encryptMedia({ plaintext: plain, mediaId, chunkSize: CHUNK })
  const last = cipherChunkSize(CHUNK)
  const truncated = out.object.subarray(0, out.object.length - last)
  assert.ok(truncated.length < out.object.length)
  assert.throws(() => decryptMedia({ object: truncated, mediaId, dek: out.dek }), (err: Error) => {
    assert.equal(err.message, MEDIA_OPEN_FAIL)
    return true
  })
})

test('header is 64 bytes and does not hold the DEK', () => {
  const { mediaId, plain } = fiveChunkPlain()
  const dek = newDek()
  const prefix = newNoncePrefix()
  const out = encryptMedia({ plaintext: plain, mediaId, chunkSize: CHUNK, dek, noncePrefix: prefix })
  const head = out.object.subarray(0, HEADER_BYTES)
  assert.equal(head.length, HEADER_BYTES)
  assert.equal(head.includes(dek), false)
  assert.equal(out.object.includes(dek), false)
  assert.equal(head.subarray(16, 24).equals(prefix), true)
})

test('wrong isLast AAD fails a chunk', () => {
  const mediaId = randomUUID()
  const dek = newDek()
  const prefix = newNoncePrefix()
  const sealed = encryptChunk({
    dek,
    prefix,
    mediaId,
    chunkIndex: 0,
    isLast: true,
    plaintext: Buffer.alloc(8, 7)
  })
  assert.throws(
    () =>
      decryptChunk({
        dek,
        prefix,
        mediaId,
        chunkIndex: 0,
        isLast: false,
        ciphertext: sealed
      }),
    (err: Error) => err.message === MEDIA_OPEN_FAIL
  )
  assert.equal(sealed.length, 8 + GCM_TAG_BYTES)
})
