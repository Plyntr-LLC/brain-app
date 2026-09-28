import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export type DirectoryBucket = {
  bucket: string
  bucket_status: 'on'
  dir: string
}

export function dryBucketRoot(userData: string): string {
  return join(userData, 'media-dry-bucket')
}

export function enableDirectoryBucket(userData: string, bucket: string): DirectoryBucket {
  const name = String(bucket || '').toLowerCase()
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(name)) throw new Error('Bad bucket name.')
  const dir = join(dryBucketRoot(userData), name)
  mkdirSync(dir, { recursive: true })
  return { bucket: name, bucket_status: 'on', dir }
}

export function dryObjectPath(userData: string, bucket: string, objectKey: string): string {
  const key = String(objectKey || '')
  if (!/^o\/[A-Za-z0-9._-]+$/.test(key)) throw new Error('Bad object key.')
  const { dir } = enableDirectoryBucket(userData, bucket)
  return join(dir, ...key.split('/'))
}

export function putDryObject(userData: string, bucket: string, objectKey: string, bytes: Buffer): string {
  const path = dryObjectPath(userData, bucket, objectKey)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, bytes)
  return path
}

export function readDryObject(userData: string, bucket: string, objectKey: string): Buffer {
  const path = dryObjectPath(userData, bucket, objectKey)
  if (!existsSync(path)) throw new Error('missing object')
  return readFileSync(path)
}
