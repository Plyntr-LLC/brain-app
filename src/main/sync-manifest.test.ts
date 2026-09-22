import assert from 'node:assert/strict'
import test from 'node:test'
import { parseSyncManifest } from './sync-manifest-parse.ts'

const ok = {
  version: 1,
  mode: 'plyntr',
  repo: 'harolds-books/harolds-books-brain',
  githubApp: 'plyntr-brain-sync',
  bridgeApp: 'plyntr-brain-bridge',
  createdAt: '2026-09-22T00:00:00.000Z'
}

test('parseSyncManifest accepts a plyntr file and matches origin', () => {
  const parsed = parseSyncManifest(ok, 'https://github.com/harolds-books/harolds-books-brain.git')
  assert.equal(parsed.ok, true)
  if (parsed.ok) assert.equal(parsed.manifest.repo, 'harolds-books/harolds-books-brain')
})

test('parseSyncManifest fails closed on unknown version, mode, app, and repo mismatch', () => {
  assert.equal(parseSyncManifest({ ...ok, version: 2 }).ok, false)
  assert.equal(parseSyncManifest({ ...ok, mode: 'other' }).ok, false)
  assert.equal(parseSyncManifest({ ...ok, githubApp: 'agency-brain-sync' }).ok, false)
  assert.equal(parseSyncManifest({ ...ok, mode: 'agency-brain', githubApp: 'plyntr-brain-sync' }).ok, false)
  const mismatch = parseSyncManifest(ok, 'git@github.com:other/other-brain.git')
  assert.equal(mismatch.ok, false)
  const agency = parseSyncManifest({ ...ok, mode: 'agency-brain', githubApp: 'agency-brain-sync' })
  assert.equal(agency.ok, true)
})
