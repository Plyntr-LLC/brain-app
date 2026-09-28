import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { MAGIC } from './format.ts'

export function cachePath(userData: string, mediaBrainId: string, mediaId: string): string {
  const brain = String(mediaBrainId || '')
  const id = String(mediaId || '')
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(brain)) throw new Error('Bad media brain id.')
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('Bad media id.')
  return join(userData, 'media', brain, 'cache', `${id}.bin`)
}

export function writeCipherCache(userData: string, mediaBrainId: string, mediaId: string, object: Buffer): string {
  if (!Buffer.isBuffer(object) || object.length < 8 || !object.subarray(0, 8).equals(MAGIC)) {
    throw new Error('Cache only stores ciphertext objects.')
  }
  const path = cachePath(userData, mediaBrainId, mediaId)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, object)
  return path
}

export function readCipherCache(userData: string, mediaBrainId: string, mediaId: string): Buffer {
  return readFileSync(cachePath(userData, mediaBrainId, mediaId))
}

export function deleteCipherCache(userData: string, mediaBrainId: string, mediaId: string): void {
  try {
    unlinkSync(cachePath(userData, mediaBrainId, mediaId))
  } catch {
    /* */
  }
}
