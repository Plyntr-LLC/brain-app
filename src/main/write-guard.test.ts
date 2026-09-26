import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'
import { NO_SEAT_WRITE_REFUSAL, TEAM_WRITE_REFUSAL, brainWriteBlock } from './write-guard.ts'

const root = '/tmp/acme-brain'

test('agency team cannot write skills or team config through Brain.app', () => {
  assert.equal(brainWriteBlock('team', root, join(root, 'skills', 'offer.md')), TEAM_WRITE_REFUSAL)
  assert.equal(brainWriteBlock('member', root, join(root, 'skills')), TEAM_WRITE_REFUSAL)
  assert.equal(brainWriteBlock('team', root, 'skills/nested/file.md'), TEAM_WRITE_REFUSAL)
  assert.equal(brainWriteBlock('team', root, join(root, '.team-config', 'roles.json')), TEAM_WRITE_REFUSAL)
  assert.equal(brainWriteBlock('team', root, join(root, '.team-config', 'sync.json')), TEAM_WRITE_REFUSAL)
  assert.equal(brainWriteBlock('Team', root, join(root, 'Skills', 'a.md')), TEAM_WRITE_REFUSAL)
  assert.equal(brainWriteBlock('team', root, join(root, 'clients', '..', 'skills', 'a.md')), TEAM_WRITE_REFUSAL)
})

test('owner and scout can write skills and team config', () => {
  for (const role of ['owner', 'scout', 'head_scout']) {
    assert.equal(brainWriteBlock(role, root, join(root, 'skills', 'offer.md')), null)
    assert.equal(brainWriteBlock(role, root, join(root, '.team-config', 'sync.json')), null)
  }
})

test('agency team can still write the rest of the repo', () => {
  assert.equal(brainWriteBlock('team', root, join(root, 'clients', 'acme.md')), null)
  assert.equal(brainWriteBlock('team', root, join(root, 'projects', 'site', 'notes.md')), null)
  assert.equal(brainWriteBlock('team', root, join(root, 'code', 'app.ts')), null)
  assert.equal(brainWriteBlock('team', root, join(root, 'AGENTS.md')), null)
  assert.equal(brainWriteBlock('team', root, join(root, 'skills', '..', 'clients', 'a.md')), null)
  assert.equal(brainWriteBlock('team', root, '/tmp/elsewhere/skills/a.md'), null)
})

test('a login with no seat on this brain cannot write skills or team config', () => {
  assert.equal(brainWriteBlock('', root, join(root, 'skills', 'a.md')), NO_SEAT_WRITE_REFUSAL)
  assert.equal(brainWriteBlock(null, root, join(root, '.team-config', 'roles.json')), NO_SEAT_WRITE_REFUSAL)
  assert.equal(brainWriteBlock('', root, join(root, 'clients', 'a.md')), null)
})
