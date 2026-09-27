import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { sh, tmpRepo } from './test-git.ts'
import { EventEmitter } from 'node:events'
import {
  BRAIN_WRITE_REFUSAL,
  deploy,
  deployBlock,
  ensureShims,
  factoryEnv,
  factoryWriteBlock,
  filterFactoryPermission,
  KENNEL_DEPLOY_REFUSAL,
  NO_DEPLOY_CMD,
  publish,
  publishBlock
} from './gates.ts'

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

test('deploy: no cmd and Kennel are refused; the stubbed cmd runs with no shims on PATH', async () => {
  assert.equal(deployBlock({ repo: '/x/site', cmd: '' }), NO_DEPLOY_CMD)
  assert.equal(deployBlock({ repo: '/Users/me/Projects/mykennel', cmd: 'npm run deploy' }), KENNEL_DEPLOY_REFUSAL)
  assert.equal(deployBlock({ repo: '/x/site', cmd: 'npm run deploy' }), null)
  let spawned = 0
  const refuse = await deploy('/x/MyKennel-app', 'npm run deploy', { spawnFn: (() => void spawned++) as never })
  assert.deepEqual(refuse, { ok: false, out: KENNEL_DEPLOY_REFUSAL })
  const none = await deploy('/x/site', '  ', { spawnFn: (() => void spawned++) as never })
  assert.deepEqual(none, { ok: false, out: NO_DEPLOY_CMD })
  assert.equal(spawned, 0)
  const seen: { bin: string; args: string[]; path: string; prompt: string | undefined; cwd: unknown; detached: unknown }[] = []
  const stub = ((bin: string, args: string[], opts: { env: NodeJS.ProcessEnv; cwd: unknown; detached?: boolean }) => {
    seen.push({ bin, args, path: String(opts.env.PATH), prompt: opts.env.GIT_TERMINAL_PROMPT, cwd: opts.cwd, detached: opts.detached })
    const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => boolean }
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.kill = () => true
    setTimeout(() => {
      child.stdout.emit('data', Buffer.from('deployed\n'))
      child.emit('close', 0)
    }, 5)
    return child
  }) as never
  // Same shape as the real shim dir: <userData>/factory/bin, first on the Factory PATH.
  const realShape = ensureShims(join(mkdtempSync(join(tmpdir(), 'factory-ud-')), 'factory', 'bin'))
  const fenv = factoryEnv({ ...process.env }, realShape)
  assert.equal(fenv.PATH?.split(':')[0], realShape)
  const ok = await deploy('/x/site', 'npm run deploy', { spawnFn: stub, env: fenv })
  assert.deepEqual(ok, { ok: true, out: 'deployed' })
  assert.equal(seen[0].bin, '/bin/sh')
  assert.deepEqual(seen[0].args, ['-c', 'npm run deploy'])
  assert.equal(seen[0].cwd, '/x/site')
  assert.equal(seen[0].prompt, '0')
  assert.equal(seen[0].detached, true)
  assert.ok(!seen[0].path.split(':').includes(realShape), seen[0].path)
  assert.ok(!/[\\/]factory[\\/]bin(:|$)/.test(seen[0].path))
})

test('deploy: a timeout kills the whole process group, not only /bin/sh', async () => {
  // A cmd that never exits on its own; closes only when something kills it.
  const kids = new Map<number, EventEmitter>()
  const kills: string[] = []
  const hang = (pid: number) =>
    (() => {
      const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; pid: number; kill: (s: string) => boolean }
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      child.pid = pid
      child.kill = (s) => {
        kills.push(`child:${s}`)
        setTimeout(() => child.emit('close', null), 1)
        return true
      }
      kids.set(pid, child)
      return child
    }) as never
  const realKill = process.kill
  const group: [number, string | number | undefined][] = []
  try {
    process.kill = ((pid: number, sig?: string | number) => {
      group.push([pid, sig])
      const kid = kids.get(-pid)
      setTimeout(() => kid?.emit('close', null), 1)
      return true
    }) as typeof process.kill
    const res = await deploy('/x/site', 'npm run deploy', { spawnFn: hang(4242), timeoutMs: 5 })
    assert.deepEqual(group, [[-4242, 'SIGKILL']])
    assert.deepEqual(kills, [])
    assert.equal(res.ok, false)

    // The group kill throws (already gone, no permission): fall back to the child.
    group.length = 0
    process.kill = ((pid: number, sig?: string | number) => {
      group.push([pid, sig])
      throw new Error('ESRCH')
    }) as typeof process.kill
    const res2 = await deploy('/x/site', 'npm run deploy', { spawnFn: hang(4343), timeoutMs: 5 })
    assert.deepEqual(group, [[-4343, 'SIGKILL']])
    assert.deepEqual(kills, ['child:SIGKILL'])
    assert.equal(res2.ok, false)
  } finally {
    process.kill = realKill
  }
})
