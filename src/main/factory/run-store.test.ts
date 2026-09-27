import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { sh, tmpRepo } from './test-git.ts'
import { realish, underPath } from './paths.ts'
import { acquireLock, activeRunFor, factoryDir, holdsLock, listRuns, loadRun, releaseLock, saveRun, setUserDataDir, type RunRecord } from './run-store.ts'

const userData = mkdtempSync(join(tmpdir(), 'factory-ud-'))
setUserDataDir(() => userData)
const brain = tmpRepo('factory-rs-brain-')
const work = tmpRepo('factory-rs-work-')

function rec(id: string, over: Partial<RunRecord> = {}): RunRecord {
  return {
    id,
    title: 'fix typo in footer',
    task: 'fix typo in footer',
    brainPath: brain,
    workRepo: work,
    tier: 'T0',
    risk: 'none',
    triage: { size: 'T0', original: 'T0', capped: false, reasons: [] },
    phase: 'build',
    base: 'abc',
    acpTab: 'factory-' + id,
    grokSessionId: 'grok-sess-1',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...over
  }
}

test('store lives under userData only and repos stay clean', () => {
  assert.ok(underPath(realish(userData), realish(factoryDir())))
  assert.equal(underPath(realish(brain), realish(factoryDir())), false)
  assert.equal(underPath(realish(work), realish(factoryDir())), false)
  saveRun(rec('run-clean'))
  assert.equal(acquireLock(work, { runId: 'run-clean', title: 't' }).ok, true)
  assert.equal(sh(brain, ['status', '--porcelain']).trim(), '')
  assert.equal(sh(work, ['status', '--porcelain']).trim(), '')
  releaseLock(work, 'run-clean')
})

test('save, drop memory, load gives the same run', () => {
  const saved = saveRun(rec('run-save', { tier: 'T1' }))
  const back = loadRun('run-save')
  assert.equal(back?.phase, 'build')
  assert.equal(back?.tier, 'T1')
  assert.equal(back?.workRepo, work)
  assert.equal(back?.grokSessionId, 'grok-sess-1')
  assert.ok(listRuns().some((r) => r.id === saved.id))
})

test('second lock on the same repo is refused, also via a symlink, until done or abandon', () => {
  const repo = tmpRepo('factory-lock-')
  const link = join(mkdtempSync(join(tmpdir(), 'factory-link-')), 'repo-link')
  symlinkSync(repo, link)
  saveRun(rec('run-a', { workRepo: repo }))
  saveRun(rec('run-b', { workRepo: repo }))
  assert.equal(acquireLock(repo, { runId: 'run-a', title: 'first run' }).ok, true)
  const second = acquireLock(repo, { runId: 'run-b', title: 'second' })
  assert.equal(second.ok, false)
  assert.equal(second.ok ? '' : second.title, 'first run')
  assert.equal(acquireLock(link, { runId: 'run-b', title: 'second' }).ok, false)
  assert.equal(activeRunFor(link)?.runId, 'run-a')
  releaseLock(repo, 'run-a')
  assert.equal(acquireLock(link, { runId: 'run-b', title: 'second' }).ok, true)
  assert.equal(holdsLock(repo, 'run-b'), true)
  // A lock held by a finished run no longer blocks.
  saveRun(rec('run-b', { workRepo: repo, phase: 'done' }))
  saveRun(rec('run-c', { workRepo: repo }))
  assert.equal(acquireLock(repo, { runId: 'run-c', title: 'third' }).ok, true)
  saveRun(rec('run-c', { workRepo: repo, phase: 'abandoned' }))
  assert.equal(acquireLock(repo, { runId: 'run-d', title: 'fourth' }).ok, true)
})

test('store refuses a userData inside the work repo', () => {
  const repo = tmpRepo('factory-inside-')
  const inside = join(repo, '.appdata')
  mkdirSync(inside)
  setUserDataDir(() => inside)
  try {
    assert.throws(() => saveRun(rec('run-in', { workRepo: repo })), /inside a repo/)
    assert.throws(() => acquireLock(repo, { runId: 'run-in', title: 't' }), /inside a repo/)
  } finally {
    setUserDataDir(() => userData)
  }
})
