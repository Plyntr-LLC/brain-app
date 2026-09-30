/**
 * Two local repos. No network. Proves a diverged Brain.app sync pauses, and discard
 * brings in the other computer without pushing.
 */
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { discardLocalSync, gitSyncAuthed, redact, setGitRunnerForCheck } from './clone'
import {
  discardDivergedSync,
  holdDiscardForCheck,
  holdTickForCheck,
  lastBrainSyncError,
  noteSyncForCheck,
  resetTickReachedForCheck,
  setCwdForCheck,
  setTokenForCheck,
  syncAttention,
  tickForCheck,
  tickReachedGitForCheck
} from './brain-sync'
import { NEEDS_ATTENTION, paintHealth } from './sync-health-paint'

function git(cwd: string, args: string[]): string {
  return execFileSync('/usr/bin/git', ['-c', 'credential.helper=', ...args], { cwd, encoding: 'utf8' })
}

function setupRepo(dir: string): void {
  mkdirSync(dir, { recursive: true })
  git(dir, ['init', '-b', 'main'])
  git(dir, ['config', 'user.email', 'sync-check@example.com'])
  git(dir, ['config', 'user.name', 'Sync check'])
  writeFileSync(join(dir, 'note.txt'), 'one\n')
  git(dir, ['add', 'note.txt'])
  git(dir, ['commit', '-m', 'one'])
}

function sha(dir: string): string {
  return git(dir, ['rev-parse', 'HEAD']).trim()
}

function fail(msg: string): never {
  throw new Error(msg)
}

function realGit(cwd: string, args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn('/usr/bin/git', ['-c', 'credential.helper=', ...args], { cwd })
    let out = ''
    child.stdout.on('data', (d) => { out += String(d) })
    child.stderr.on('data', (d) => { out += String(d) })
    child.on('error', (err) => resolve({ code: 1, out: String(err.message || err) }))
    child.on('close', (code) => resolve({ code: code ?? 1, out }))
  })
}

test('diverged Brain.app sync pauses and discard does not push', async () => {
const root = mkdtempSync(join(tmpdir(), 'brain-sync-attention-'))
const a = join(root, 'a')
const b = join(root, 'b')
try {
  setupRepo(a)
  setupRepo(b)
  const base = sha(a)
  if (sha(b) === base) {
    /* both started from "one"; rewrite b to the same commit by fetching a */
  }
  git(b, ['remote', 'add', 'origin', a])
  git(b, ['fetch', 'origin'])
  git(b, ['reset', '--hard', 'origin/main'])
  const shared = sha(a)
  if (sha(b) !== shared) fail('repos did not share a base')

  writeFileSync(join(a, 'note.txt'), 'from-a\n')
  git(a, ['add', 'note.txt'])
  git(a, ['commit', '-m', 'a'])
  const aSha = sha(a)

  writeFileSync(join(b, 'note.txt'), 'from-b\n')
  git(b, ['add', 'note.txt'])
  git(b, ['commit', '-m', 'b'])
  const bSha = sha(b)

  const diverged = await gitSyncAuthed(b, '')
  if (diverged.status !== 'attention') fail('diverged status ' + JSON.stringify(diverged))
  if (!diverged.files.includes('note.txt')) fail('files ' + diverged.files.join(','))
  if (sha(b) !== bSha) fail('local commit moved')
  if (git(b, ['rev-parse', 'origin/main']).trim() !== aSha) fail('origin did not stay the other computer')
  if (git(b, ['rev-list', '--merges', 'HEAD']).trim()) fail('merge commit appeared')
  noteSyncForCheck(b, diverged)
  if (lastBrainSyncError(b).includes('note.txt')) fail('file name stored in lastError')
  const health = paintHealth(
    { present: true, label: 'b', lastSync: '', offline: false, error: '', attention: true, tip: syncAttention(b)?.files.join('\n') || '' },
    false
  )
  if (health.line !== NEEDS_ATTENTION || health.ok !== false) fail('health line ' + health.line)
  if ((health.error || '').includes('note.txt')) fail('file name in error')
  if (!(health.tip || '').includes('note.txt')) fail('file name missing from tooltip')
  if (health.line.includes('note.txt')) fail('file name in the pill line')

  const before = await discardDivergedSync(b)
  if (!before.ok) fail('discard refused attention: ' + before.detail)
  if (readFileSync(join(b, 'note.txt'), 'utf8') !== 'from-a\n') fail('discard did not take the other computer')
  if (sha(a) !== aSha) fail('discard pushed onto the other computer')

  writeFileSync(join(b, 'extra.txt'), 'dirty\n')
  noteSyncForCheck(b, { status: 'attention', files: ['note.txt'] })
  const dirty = await discardDivergedSync(b)
  if (dirty.ok) fail('dirty discard succeeded')
  if (readFileSync(join(b, 'extra.txt'), 'utf8') !== 'dirty\n') fail('dirty file removed')
  rmSync(join(b, 'extra.txt'))

  const resumed = await gitSyncAuthed(b, '')
  if (resumed.status !== 'ok') fail('resume ' + JSON.stringify(resumed))
  if (sha(a) !== aSha) fail('resume pushed')
  if (readFileSync(join(b, 'note.txt'), 'utf8') !== 'from-a\n') fail('resume rewrote the file')

  const dead = join(root, 'dead')
  setupRepo(dead)
  git(dead, ['remote', 'add', 'origin', 'https://127.0.0.1:9/nope.git'])
  setGitRunnerForCheck(async (cwd, args) => {
    if (args[0] === 'fetch') return { code: 1, out: 'fetch failed' }
    return realGit(cwd, args)
  })
  const deadRes = await gitSyncAuthed(dead, '')
  if (deadRes.status !== 'failed') fail('dead origin ' + JSON.stringify(deadRes))
  noteSyncForCheck(dead, deadRes)
  const deadDiscard = await discardDivergedSync(dead)
  if (deadDiscard.ok) fail('discard offered after a dead origin')
  setGitRunnerForCheck(null)

  const missing = join(root, 'missing')
  setupRepo(missing)
  git(missing, ['remote', 'add', 'origin', a])
  setGitRunnerForCheck((cwd, args) => {
    if (args[0] === 'fetch') return Promise.resolve({ code: 0, out: '' })
    return realGit(cwd, args)
  })
  const miss = await gitSyncAuthed(missing, '')
  setGitRunnerForCheck(null)
  if (miss.status === 'attention') fail('missing branch looked like attention ' + JSON.stringify(miss))
  if (miss.status !== 'failed') fail('missing branch ' + JSON.stringify(miss))
  const missDiscard = await discardDivergedSync(missing)
  if (missDiscard.ok) fail('discard offered with no origin branch')

  const ahead = join(root, 'ahead')
  setupRepo(ahead)
  git(ahead, ['remote', 'add', 'origin', a])
  git(ahead, ['fetch', 'origin'])
  git(ahead, ['reset', '--hard', 'origin/main'])
  const onlyRemote = await gitSyncAuthed(ahead, '')
  if (onlyRemote.status !== 'ok') fail('fast-forward ' + JSON.stringify(onlyRemote))
  const same = await gitSyncAuthed(ahead, '')
  if (same.status !== 'ok') fail('up to date ' + JSON.stringify(same))

  setCwdForCheck(b)
  setTokenForCheck(() => '')
  resetTickReachedForCheck()
  const releaseDiscard = holdDiscardForCheck()
  await tickForCheck()
  if (tickReachedGitForCheck()) fail('tick touched git during discard')
  releaseDiscard()
  resetTickReachedForCheck()
  await tickForCheck()
  if (!tickReachedGitForCheck()) fail('tick stayed locked after discard')
  setTokenForCheck(null)

  noteSyncForCheck(b, { status: 'attention', files: ['note.txt'] })
  const releaseTick = holdTickForCheck()
  const during = await discardDivergedSync(b)
  if (during.ok) fail('discard ran during tick')
  if (!/still running/i.test(during.detail)) fail('discard during tick: ' + during.detail)
  releaseTick()
  const after = await discardLocalSync(b)
  if (!after.ok) fail('lock stuck: ' + after.detail)

  const secretRepo = join(root, 'secret')
  setupRepo(secretRepo)
  git(secretRepo, ['remote', 'add', 'origin', 'https://example.invalid/brain.git'])
  setGitRunnerForCheck(async (cwd, args) => {
    const hit = args.find((arg) => arg.includes('x-access-token:SECRET'))
    if (hit) return { code: 1, out: hit }
    return realGit(cwd, args)
  })
  const leaked = await gitSyncAuthed(secretRepo, 'SECRET')
  setGitRunnerForCheck(null)
  const blob = JSON.stringify(leaked) + redact('x-access-token:SECRET')
  if (leaked.status !== 'failed') fail('secret fetch ' + JSON.stringify(leaked))
  const painted = paintHealth(
    { present: true, label: 's', lastSync: '', offline: false, error: leaked.detail, attention: false, tip: '' },
    false
  )
  const shown = `${painted.line}\n${painted.tip || ''}\n${JSON.stringify(leaked)}`
  if (shown.includes('x-access-token') || shown.includes('SECRET')) fail('token leaked: ' + shown)
  if (blob.includes('x-access-token')) fail('redact kept x-access-token')

  console.log('SYNC_ATTENTION_PASS')
} finally {
  setGitRunnerForCheck(null)
  setTokenForCheck(null)
  rmSync(root, { recursive: true, force: true })
}
})
