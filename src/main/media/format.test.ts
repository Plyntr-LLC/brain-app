import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { CHUNK_SIZE_MIN, MEDIA_OPEN_FAIL } from './crypto.ts'
import {
  FORMAT_VERSION,
  HEADER_BYTES,
  MAGIC,
  decodeHeader,
  decryptMedia,
  decryptRangeFromBuffer,
  decryptRangeFromPath,
  encodeHeader,
  encryptMedia,
  expectedObjectSize
} from './format.ts'

test('magic is BRMEDIA1 and version 1 sits in a 64-byte header', () => {
  const mediaId = randomUUID()
  const plain = Buffer.from('hello media')
  const out = encryptMedia({ plaintext: plain, mediaId, chunkSize: CHUNK_SIZE_MIN })
  const head = decodeHeader(out.object)
  assert.equal(out.object.subarray(0, 8).toString('ascii'), 'BRMEDIA1')
  assert.equal(MAGIC.toString('ascii'), 'BRMEDIA1')
  assert.equal(head.version, FORMAT_VERSION)
  assert.equal(head.chunkCount, 1)
  assert.equal(head.plainLen, plain.length)
  assert.equal(encodeHeader(head).length, HEADER_BYTES)
  assert.equal(decryptMedia({ object: out.object, mediaId, dek: out.dek }).toString(), 'hello media')
})

test('object size is header plus ciphertext chunks', () => {
  const mediaId = randomUUID()
  const plain = Buffer.alloc(CHUNK_SIZE_MIN * 2 + 100, 9)
  const out = encryptMedia({ plaintext: plain, mediaId, chunkSize: CHUNK_SIZE_MIN })
  assert.equal(out.header.chunkCount, 3)
  assert.equal(out.object.length, expectedObjectSize(out.header))
  assert.equal(out.object.length, HEADER_BYTES + (CHUNK_SIZE_MIN + 16) * 2 + (100 + 16))
})

test('a junk header fails', () => {
  const mediaId = randomUUID()
  const plain = Buffer.alloc(CHUNK_SIZE_MIN, 1)
  const out = encryptMedia({ plaintext: plain, mediaId, chunkSize: CHUNK_SIZE_MIN })
  const junk = Buffer.from(out.object)
  junk[0] = 'X'.charCodeAt(0)
  assert.throws(() => decryptMedia({ object: junk, mediaId, dek: out.dek }), (err: Error) => {
    assert.equal(err.message, MEDIA_OPEN_FAIL)
    return true
  })
})

test('empty plaintext round-trips with no chunks', () => {
  const mediaId = randomUUID()
  const out = encryptMedia({ plaintext: Buffer.alloc(0), mediaId, chunkSize: CHUNK_SIZE_MIN })
  assert.equal(out.header.chunkCount, 0)
  assert.equal(out.object.length, HEADER_BYTES)
  assert.equal(decryptMedia({ object: out.object, mediaId, dek: out.dek }).length, 0)
})

test('decryptRange only covers the chunks the range needs and matches the source span', () => {
  const mediaId = randomUUID()
  const plain = Buffer.alloc(CHUNK_SIZE_MIN * 5, 3)
  plain.write('PLAINTEXT-MARKER-7f3c', 100)
  const out = encryptMedia({ plaintext: plain, mediaId, chunkSize: CHUNK_SIZE_MIN })
  const start = CHUNK_SIZE_MIN + 40
  const end = plain.length - 1
  const span = decryptRangeFromBuffer({ object: out.object, mediaId, dek: out.dek, start, end })
  assert.equal(Buffer.compare(span, plain.subarray(start, end + 1)), 0)
  assert.ok(start % CHUNK_SIZE_MIN !== 0)
  assert.ok(Math.floor(start / CHUNK_SIZE_MIN) < Math.floor(end / CHUNK_SIZE_MIN))
})

test('decryptRange from a path matches the buffer form', () => {
  const mediaId = randomUUID()
  const plain = Buffer.alloc(CHUNK_SIZE_MIN * 2 + 20, 4)
  const out = encryptMedia({ plaintext: plain, mediaId, chunkSize: CHUNK_SIZE_MIN })
  const dir = mkdtempSync(join(tmpdir(), 'media-range-'))
  const path = join(dir, 'obj.bin')
  try {
    writeFileSync(path, out.object)
    const start = 10
    const end = plain.length - 1
    const fromPath = decryptRangeFromPath({ path, mediaId, dek: out.dek, start, end })
    const fromBuf = decryptRangeFromBuffer({ object: out.object, mediaId, dek: out.dek, start, end })
    assert.equal(Buffer.compare(fromPath, fromBuf), 0)
    assert.equal(Buffer.compare(fromPath, plain.subarray(start, end + 1)), 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
