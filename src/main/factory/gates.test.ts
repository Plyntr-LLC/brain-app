import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { tmpRepo } from './test-git.ts'
import { BRAIN_WRITE_REFUSAL, ensureShims, factoryEnv, factoryWriteBlock, filterFactoryPermission } from './gates.ts'

const shimDir = ensureShims(join(mkdtempSync(join(tmpdir(), 'factory-shim-')), 'bin'))
const env = factoryEnv({ ...process.env, ANTHROPIC_API_KEY: 'fixture-not-a-key' }, shimDir)
const repo = tmpRepo('factory-gates-')
const run = (cmd: string, args: string[]) => spawnSync(cmd, args, { cwd: repo, env, encoding: 'utf8' })

test('factory env puts shims first and drops ANTHROPIC_API_KEY', () => {
  assert.equal(env.PATH?.split(':')[0], shimDir)
  assert.equal('ANTHROPIC_API_KEY' in env, false)
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
