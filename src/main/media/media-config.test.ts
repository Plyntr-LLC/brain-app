import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  isProjectMiniFolder,
  readMediaConfig,
  shouldWriteMediaConfig,
  writeMediaConfig
} from './media-config.ts'

test('media.json is version 1 with mediaBrainId and no keys', () => {
  const folder = mkdtempSync(join(tmpdir(), 'media-json-'))
  try {
    assert.equal(writeMediaConfig(folder, 'brainid01brainid01brainid'), true)
    const raw = readFileSync(join(folder, '.team-config', 'media.json'), 'utf8')
    const body = JSON.parse(raw) as Record<string, unknown>
    assert.deepEqual(body, { version: 1, mediaBrainId: 'brainid01brainid01brainid' })
    assert.equal(readMediaConfig(folder)?.mediaBrainId, 'brainid01brainid01brainid')
    assert.equal(raw.includes('pms_'), false)
    assert.equal(raw.includes('pbt_'), false)
  } finally {
    rmSync(folder, { recursive: true, force: true })
  }
})

test('project mini folders never get .team-config/media.json', () => {
  const mini = mkdtempSync(join(tmpdir(), 'media-mini-'))
  try {
    writeFileSync(join(mini, 'CLAUDE.local.md'), 'x')
    assert.equal(isProjectMiniFolder(mini), true)
    assert.equal(shouldWriteMediaConfig(mini, 'owner'), false)
    assert.equal(writeMediaConfig(mini, 'brainid01brainid01brainid'), false)
    assert.equal(readMediaConfig(mini), null)
    assert.equal(shouldWriteMediaConfig(mini.replace(/$/, ''), 'project'), false)
  } finally {
    rmSync(mini, { recursive: true, force: true })
  }
})
