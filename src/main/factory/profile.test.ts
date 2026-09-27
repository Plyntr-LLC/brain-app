import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { detectProfile, profileLine, profilesDir, readProfile, saveProfile } from './profile.ts'
import { lockKey, setUserDataDir } from './run-store.ts'
import { tmpRepo } from './test-git.ts'

const pkg = JSON.stringify({ name: 'w', scripts: { typecheck: 'tsc', test: 'node --test', 'test:e2e': 'playwright test' } })

test('detect finds typecheck, test and test:e2e; voice off; origin', () => {
  const repo = tmpRepo('factory-prof-', { 'package.json': pkg })
  const p = detectProfile(repo)
  assert.deepEqual(p.scripts, { typecheck: 'typecheck', test: 'test', e2e: 'test:e2e' })
  assert.equal(p.voice.on, false)
  assert.equal(p.publish.remote, 'origin')
  assert.equal(profileLine(p), 'This repo: typecheck · test · test:e2e')
  assert.equal(profileLine(detectProfile(tmpRepo('factory-prof-none-'))), 'This repo: no scripts found')
})

test('save writes under userData/factory/profiles/<lockKey>.json and leaves the repo clean', () => {
  const repo = tmpRepo('factory-prof-save-', { 'package.json': pkg })
  const ud = mkdtempSync(join(tmpdir(), 'factory-prof-ud-'))
  setUserDataDir(() => ud)
  assert.equal(readProfile(repo).voice.on, false)
  saveProfile(repo, { voice: { on: true } })
  assert.ok(existsSync(join(ud, 'factory', 'profiles', `${lockKey(repo)}.json`)))
  assert.equal(profilesDir(), join(ud, 'factory', 'profiles'))
  const back = readProfile(repo)
  assert.equal(back.voice.on, true)
  assert.equal(back.scripts.e2e, 'test:e2e')
  assert.equal(execFileSync('/usr/bin/git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).trim(), '')
  setUserDataDir(() => join(repo, 'ud'))
  assert.throws(() => saveProfile(repo, { voice: { on: false } }), /inside a repo/)
  setUserDataDir(() => ud)
})
