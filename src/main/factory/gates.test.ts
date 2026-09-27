import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { sh, tmpRepo } from './test-git.ts'
import { BRAIN_WRITE_REFUSAL, ensureShims, factoryEnv, factoryWriteBlock, filterFactoryPermission, publish, publishBlock } from './gates.ts'

const shimDir = ensureShims(join(mkdtempSync(join(tmpdir(), 'factory-shim-')), 'bin'))
const env = factoryEnv({ ...process.env, ANTHROPIC_API_KEY: 'fixture-not-a-key', ANTHROPIC_TRANSLATOR_API_KEY: 'fixture-not-a-key' }, shimDir)
const repo = tmpRepo('factory-gates-')
const run = (cmd: string, args: string[]) => spawnSync(cmd, args, { cwd: repo, env, encoding: 'utf8' })

test('factory env puts shims first and drops ANTHROPIC_API_KEY', () => {
  assert.equal(env.PATH?.split(':')[0], shimDir)
  assert.equal('ANTHROPIC_API_KEY' in env, false)
  assert.equal('ANTHROPIC_TRANSLATOR_API_KEY' in env, false)
})

test('git shim refuses push in every spelling and passes the rest', () => {
  for (const args of [['push', 'origin', 'main'], ['-C', repo, 'push'], ['-c', 'x.y=z', 'push'], ['--no-pager', 'push']]) {
    const r = run('git', args)
    assert.equal(r.status, 1, args.join(' '))
    assert.match(r.stderr, /do not push/)
  }
  assert.equal(run('git', ['status']).status, 0)
  assert.equal(run('git', ['log', '--grep', 'push', '--oneline']).status, 0)
  assert.equal(run('git', ['commit', '--allow-empty', '-q', '-m', 'push notes']).status, 0)
})

test('gh shim always refuses', () => {
  const r = run('gh', ['pr', 'create'])
  assert.equal(r.status, 1)
  assert.match(r.stderr, /do not use gh/)
})

const ask = (title: string, rawInput: unknown = {}, kind = 'execute') => ({
  params: { sessionId: 's', toolCall: { title, kind, rawInput }, options: [] }
})
const ctx = { brainPath: '/tmp/fx-brain', workRepo: '/tmp/fx-work' }

test('publish verbs are rejected by the filter', () => {
  for (const cmd of ['git push origin main', 'gh pr create --fill', 'npx wrangler deploy', 'npm publish', 'vercel --prod', 'fly deploy', 'git -C /x push']) {
    assert.equal(filterFactoryPermission(ask(cmd), ctx), 'reject', cmd)
    assert.equal(filterFactoryPermission(ask('Run command', { command: cmd }), ctx), 'reject', cmd)
  }
  for (const cmd of ['npm run typecheck', 'git status', 'git commit -m "push notes"', 'cat vercel.json', 'ls ghost']) {
    assert.equal(filterFactoryPermission(ask('Run command', { command: cmd }), ctx), 'ask', cmd)
  }
})

test('edits in the brain are rejected when the work repo is elsewhere', () => {
  assert.equal(filterFactoryPermission(ask('Edit', { path: '/tmp/fx-brain/AGENTS.md' }, 'edit'), ctx), 'reject')
  assert.equal(filterFactoryPermission(ask('Read', { path: '/tmp/fx-brain/AGENTS.md' }, 'read'), ctx), 'ask')
  assert.equal(filterFactoryPermission(ask('Edit', { path: '/tmp/fx-work/src/a.ts' }, 'edit'), ctx), 'ask')
  assert.equal(filterFactoryPermission(ask('Edit', { path: 'AGENTS.md' }, 'edit'), ctx), 'reject')
  assert.equal(filterFactoryPermission(ask('Edit', { path: 'skills/x.md' }, 'edit'), ctx), 'reject')
  assert.equal(filterFactoryPermission(ask('Edit', { path: '../fx-work/src/a.ts' }, 'edit'), ctx), 'ask')
})

test('factoryWriteBlock refuses the brain and allows the work repo, even nested', () => {
  const root = mkdtempSync(join(tmpdir(), 'factory-wb-'))
  const brain = join(root, 'brain')
  const work = join(root, 'work')
  mkdirSync(brain)
  mkdirSync(work)
  assert.equal(factoryWriteBlock(join(brain, 'AGENTS.md'), brain, work), BRAIN_WRITE_REFUSAL)
  assert.equal(factoryWriteBlock(join(work, 'src', 'a.ts'), brain, work), null)
  const nested = join(brain, 'code', 'site')
  mkdirSync(nested, { recursive: true })
  assert.equal(factoryWriteBlock(join(nested, 'a.ts'), brain, nested), null)
  assert.equal(factoryWriteBlock(join(brain, 'AGENTS.md'), brain, nested), BRAIN_WRITE_REFUSAL)
})

test('publish pushes a factory branch to a bare origin; protected, moved, detached, and no remote are refused', async () => {
  const bare = mkdtempSync(join(tmpdir(), 'factory-bare-'))
  sh(bare, ['init', '-q', '--bare', '-b', 'main'])
  const work = tmpRepo('factory-pub-')
  sh(work, ['remote', 'add', 'origin', bare])
  sh(work, ['checkout', '-q', '-b', 'factory/x'])
  sh(work, ['commit', '-q', '--allow-empty', '-m', 'run'])
  const sha = sh(work, ['rev-parse', 'HEAD']).trim()
  assert.equal(publishBlock({ repo: work, remote: 'origin', branch: 'factory/x', sha }), null)
  assert.match(String(publishBlock({ repo: work, remote: 'origin', branch: 'main', sha })), /does not push to main/)
  assert.match(String(publishBlock({ repo: work, remote: 'origin', branch: 'staging', sha })), /does not push to staging/)
  assert.match(String(publishBlock({ repo: work, remote: 'nope', branch: 'factory/x', sha })), /no remote named nope/)
  assert.match(String(publishBlock({ repo: work, remote: 'origin', branch: '', sha })), /detached/)
  const r = await publish(work, { remote: 'origin', branch: 'factory/x', sha })
  assert.equal(r.ok, true, r.out)
  assert.equal(sh(bare, ['rev-parse', 'refs/heads/factory/x']).trim(), sha)
  assert.match(String(publishBlock({ repo: work, remote: 'origin', branch: 'factory/x', sha })), /Already pushed/)
  sh(work, ['commit', '-q', '--allow-empty', '-m', 'moved'])
  assert.match(String(publishBlock({ repo: work, remote: 'origin', branch: 'factory/x', sha })), /moved since Factory committed/)
  const moved = await publish(work, { remote: 'origin', branch: 'factory/x', sha })
  assert.equal(moved.ok, false)
  assert.equal(sh(bare, ['rev-parse', 'refs/heads/factory/x']).trim(), sha)
  const shim = spawnSync('git', ['push', 'origin', 'factory/x'], { cwd: work, env, encoding: 'utf8' })
  assert.equal(shim.status, 1)
})
