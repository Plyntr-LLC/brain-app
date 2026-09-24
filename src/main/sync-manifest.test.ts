import assert from 'node:assert/strict'
import test from 'node:test'
import { canTurnOnGithubSync, channelSkipsGithub } from '../shared/contracts.ts'
import { effectiveSyncMode, parseSyncManifest } from './sync-manifest-parse.ts'

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

test('local setup skips GitHub, and only an owner or scout can turn sync on', () => {
  assert.equal(channelSkipsGithub('local'), true)
  assert.equal(channelSkipsGithub('plyntr'), false)
  assert.equal(channelSkipsGithub('agency'), false)
  assert.equal(canTurnOnGithubSync('owner', false), true)
  assert.equal(canTurnOnGithubSync('scout', false), true)
  assert.equal(canTurnOnGithubSync('team', false), false)
  assert.equal(canTurnOnGithubSync('project', false), false)
  assert.equal(canTurnOnGithubSync('team', true), true)
})

test('a local row wins over a plyntr sync file', () => {
  const manifest = parseSyncManifest(ok, 'https://github.com/harolds-books/harolds-books-brain.git')
  assert.equal(effectiveSyncMode('local', manifest), 'local')
  assert.equal(effectiveSyncMode('plyntr', manifest), 'plyntr')
  assert.equal(effectiveSyncMode(undefined, null), null)
  assert.equal(effectiveSyncMode('agency-brain', { ok: false, error: 'no' }), 'agency-brain')
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
