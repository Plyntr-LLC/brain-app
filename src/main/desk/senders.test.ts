import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { ChildProcess } from 'node:child_process'
import { createSenders, type DeskSpawn } from './senders.ts'

const require = createRequire(import.meta.url)

type Fake = {
  spawn: DeskSpawn
  calls: { cmd: string; args: string[]; stdin: string }[]
}

function fakeSpawn(script: (args: string[], stdin: string) => { code?: number; out?: string; err?: string; hang?: boolean }): Fake {
  const calls: Fake['calls'] = []
  const spawnFn: DeskSpawn = (cmd, args) => {
    let stdin = ''
    const child = {
      stdout: { on: () => undefined },
      stderr: { on: () => undefined },
      stdin: { end: (s?: string) => { stdin = s || '' } },
      kill: () => undefined,
      on: (ev: string, fn: (code?: number | null) => void) => {
        if (ev === 'close') {
          calls.push({ cmd, args, stdin })
          const last = calls[calls.length - 1]
          const res = script(args, last.stdin)
          if (res.hang) return
          queueMicrotask(() => {
            last.stdin = stdin
            fn(res.code ?? 0)
          })
        }
      }
    } as unknown as ChildProcess
    const resLater = () => script(args, stdin)
    child.stdout.on = ((ev: string, fn: (b: string) => void) => {
      if (ev === 'data') {
        queueMicrotask(() => {
          const res = resLater()
          if (!res.hang && res.out) fn(res.out)
        })
      }
    }) as ChildProcess['stdout']['on']
    return child
  }
  return { spawn: spawnFn, calls }
}

test('the dev script path is the source gmail-send file', () => {
  const { gmailScript } = createSenders()
  const file = gmailScript()
  assert.ok(file.endsWith('gmail-send.cjs'))
  assert.match(readFileSync(file, 'utf8'), /no-token/)
})

test('gmailFrom, check, a new email, and a reply use one spawn shape', async () => {
  const fake = fakeSpawn((args) => {
    const mode = args[1]
    if (mode === 'from') return { out: 'joe@plyntr.com\n' }
    if (mode === 'check') return { out: 'ok\n' }
    return { out: 'ok\n' }
  })
  const senders = createSenders({ spawn: fake.spawn, dryRun: false })
  assert.equal(await senders.gmailFrom('/brain'), 'joe@plyntr.com')
  assert.equal(await senders.check('/brain', 'msg-1'), 'ok')
  assert.deepEqual(await senders.sendEmail('/brain', { to: 'a@b.c', cc: '', subject: 'Hi', body: 'Hello' }), { ok: true })
  assert.deepEqual(
    await senders.sendEmail('/brain', { to: 'a@b.c', cc: 'c@d.e', subject: 'Re', body: 'Back', replyTo: 'msg-9' }),
    { ok: true }
  )
  const checkCall = fake.calls.find((c) => c.args[1] === 'check')
  assert.ok(checkCall)
  assert.deepEqual(checkCall.args.slice(1), ['check', '/brain', 'msg-1'])
  assert.equal(checkCall.cmd, process.execPath)
  const reply = fake.calls.find((c) => c.stdin.includes('msg-9'))
  assert.ok(reply)
  assert.deepEqual(JSON.parse(reply.stdin), { to: 'a@b.c', cc: 'c@d.e', subject: 'Re', body: 'Back', replyTo: 'msg-9' })
  assert.equal(fake.calls.length, 4)
})

test('check that prints missing does not send', async () => {
  const fake = fakeSpawn(() => ({ out: 'missing\n' }))
  const senders = createSenders({ spawn: fake.spawn })
  assert.equal(await senders.check('/brain', 'nope'), 'missing')
  assert.equal(fake.calls.length, 1)
  assert.equal(fake.calls[0].args[1], 'check')
})

test('a missing token file exits 2 with no-token and does not stay up', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'desk-gmail-'))
  const script = createSenders().gmailScript()
  const ran = await new Promise<{ code: number | null; out: string }>((resolve) => {
    const child = spawn(process.execPath, [script, 'from', dir], { shell: false, env: { ...process.env, HOME: dir, ELECTRON_RUN_AS_NODE: '1' } })
    let out = ''
    child.stdout.on('data', (b) => { out += String(b) })
    child.on('close', (code) => resolve({ code, out }))
  })
  assert.equal(ran.code, 2)
  assert.match(ran.out, /no-token/)
})

test('a missing credentials file is no-token and authorize is not called', async () => {
  const { resolveAuthFiles } = require('./gmail-send.cjs') as {
    resolveAuthFiles: (brain: string, env: NodeJS.ProcessEnv, home: string) => { ok: boolean }
  }
  const dir = mkdtempSync(join(tmpdir(), 'desk-gmail-cred-'))
  const brain = join(dir, 'brain')
  const home = join(dir, 'home')
  const secrets = join(home, '.brain-secrets', 'google')
  mkdirSync(secrets, { recursive: true })
  writeFileSync(join(secrets, 'token-plyntr.json'), '{}')
  assert.deepEqual(resolveAuthFiles(brain, {}, home), { ok: false })
  const script = createSenders().gmailScript()
  const ran = await new Promise<{ code: number | null; out: string }>((resolve) => {
    const child = spawn(process.execPath, [script, 'from', brain], {
      shell: false,
      env: { ...process.env, HOME: home, ELECTRON_RUN_AS_NODE: '1' }
    })
    let out = ''
    child.stdout.on('data', (b) => {
      out += String(b)
    })
    child.on('close', (code) => resolve({ code, out }))
  })
  assert.equal(ran.code, 2)
  assert.match(ran.out, /no-token/)
})

test('dry-run send spawns nothing; lookup still spawns', async () => {
  const fake = fakeSpawn(() => ({ out: '{"sendable":true,"guid":"g"}\n' }))
  const senders = createSenders({ spawn: fake.spawn, dryRun: true })
  assert.deepEqual(await senders.sendEmail('/brain', { to: 'a', subject: 's', body: 'b' }), {
    ok: true,
    dryRun: true,
    note: 'Dry run. Nothing left this Mac.'
  })
  assert.deepEqual(await senders.sendText('/brain', 'guid', 'hi'), {
    ok: true,
    dryRun: true,
    note: 'Dry run. Nothing left this Mac.'
  })
  assert.equal(fake.calls.length, 0)
  await senders.lookupText('/brain', 'Brent')
  assert.equal(fake.calls.length, 1)
  assert.equal(fake.calls[0].args[1], 'lookup')
})

test('sendText passes the guid and maps the child results', async () => {
  const cases: { out: string; code?: number; expect: unknown }[] = [
    { out: '{"ok":false,"error":"Sent but no matching chat.db row yet"}\n', expect: { ok: true } },
    { out: '{"ok":false,"error":"chat.db error=1"}\n', expect: { ok: false, sendable: true, note: 'chat.db error=1' } },
    { out: '{"error":"Messages send failed: boom"}\n', code: 1, expect: { ok: false, sendable: false, note: 'This may have gone. Check Messages before trying again.' } },
    { out: '{"error":"No existing iMessage thread"}\n', code: 1, expect: { ok: false, sendable: true } }
  ]
  for (const item of cases) {
    const fake = fakeSpawn(() => ({ out: item.out, code: item.code ?? 0 }))
    const senders = createSenders({ spawn: fake.spawn, dryRun: false })
    assert.deepEqual(await senders.sendText('/b', 'guid-1', 'body text'), item.expect)
    assert.equal(fake.calls[0].args[1], 'send')
    assert.equal(fake.calls[0].args[3], 'guid-1')
    assert.equal(fake.calls[0].stdin, 'body text')
    assert.ok(String(fake.calls[0].args[0]).endsWith('imessage.cjs'))
  }
})

test('WhatsApp does not call the text sender', () => {
  const fake = fakeSpawn(() => ({ out: '' }))
  const senders = createSenders({ spawn: fake.spawn })
  assert.deepEqual(senders.sendWhatsApp(), { ok: false, sendable: false })
  assert.equal(fake.calls.length, 0)
})

test('a 15 second email kill and a 25 second text kill return the check notes', async () => {
  const hang: DeskSpawn = () => {
    const child = {
      stdout: { on: () => undefined },
      stderr: { on: () => undefined },
      stdin: { end: () => undefined },
      kill: () => undefined,
      on: () => undefined
    }
    return child as unknown as ChildProcess
  }
  const senders = createSenders({ spawn: hang, dryRun: false, emailKillMs: 20, textKillMs: 20 })
  const email = await senders.sendEmail('/b', { to: 'a', subject: 's', body: 'b' })
  assert.deepEqual(email, { ok: false, killed: true, sendable: false, note: 'This may have gone. Check Sent in Gmail before trying again.' })
  const text = await senders.sendText('/b', 'guid', 'body')
  assert.deepEqual(text, { ok: false, killed: true, sendable: false, note: 'This may have gone. Check Messages before trying again.' })
})

