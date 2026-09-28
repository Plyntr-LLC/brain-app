import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { mintedFilePath, mintedMatchesDevice, readMintedInvites, recordMintedInvite, sameRoots } from './minted.ts'

test('minted.json records email and roots for auto-wrap', () => {
  const userData = mkdtempSync(join(tmpdir(), 'media-minted-'))
  try {
    recordMintedInvite(userData, 'brainid01brainid01brainid', {
      inviteEmail: 'alpha-person@example.test',
      roots: ['projects/alpha']
    })
    recordMintedInvite(userData, 'brainid01brainid01brainid', {
      inviteEmail: 'alpha-keeper@example.test',
      roots: ['projects/alpha/']
    })
    const rows = readMintedInvites(userData, 'brainid01brainid01brainid')
    assert.equal(rows.length, 2)
    assert.equal(rows[0].inviteEmail, 'alpha-person@example.test')
    assert.deepEqual(rows[0].roots, ['projects/alpha/'])
    assert.equal(
      mintedMatchesDevice(rows, 'alpha-person@example.test', ['projects/alpha/']),
      true
    )
    assert.equal(
      mintedMatchesDevice(rows, 'beta-person@example.test', ['projects/beta/']),
      false
    )
    const raw = readFileSync(mintedFilePath(userData, 'brainid01brainid01brainid'), 'utf8')
    assert.equal(raw.includes('inviteEmail'), true)
    assert.equal(sameRoots(['projects/alpha/'], ['projects/alpha']), true)
  } finally {
    rmSync(userData, { recursive: true, force: true })
  }
})
