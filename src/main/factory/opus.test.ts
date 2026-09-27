import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { opusArgs, runOpus, STRICT_SKILL_PATH, strictNeeded, strictPrompt, verdict } from './opus.ts'

test('strict is needed for T2, elevated, critical, and MyPuppies paths only', () => {
  assert.equal(strictNeeded({ tier: 'T2', risk: 'none', workRepo: '/x/site' }), true)
  assert.equal(strictNeeded({ tier: 'T3', risk: 'none', workRepo: '/x/site' }), true)
  assert.equal(strictNeeded({ tier: 'T0', risk: 'elevated', workRepo: '/x/site' }), true)
  assert.equal(strictNeeded({ tier: 'T1', risk: 'critical', workRepo: '/x/site' }), true)
  assert.equal(strictNeeded({ tier: 'T0', risk: 'none', workRepo: '/x/MyPuppies-site' }), true)
  assert.equal(strictNeeded({ tier: 'T0', risk: 'none', workRepo: '/x/site' }), false)
  assert.equal(strictNeeded({ tier: 'T1', risk: 'none', workRepo: '/x/site' }), false)
})

test('strict prompt names the skill by path and never pastes its body', () => {
  const p = strictPrompt({ task: 'fix it', tier: 'T2', risk: 'none', base: 'abc123', diff: '+x', workRepo: '/x/site' })
  assert.ok(p.includes(STRICT_SKILL_PATH))
  assert.ok(p.includes('git diff abc123'))
  assert.ok(p.trimEnd().endsWith('Your last line must be exactly PASS or FAIL.'))
  if (existsSync(STRICT_SKILL_PATH)) {
    const head = readFileSync(STRICT_SKILL_PATH, 'utf8').slice(0, 200)
    assert.ok(!p.includes(head))
  }
})

test('verdict reads the last non-empty line', () => {
  assert.equal(verdict('looks fine\n\nPASS\n\n'), 'PASS')
  assert.equal(verdict('bug at a.ts:3\nFAIL'), 'FAIL')
  assert.equal(verdict('PASS\nbut wait'), null)
  assert.equal(verdict(''), null)
})

test('argv shape and a fresh process with no stdin, no keys, no shell', async () => {
  const a = opusArgs('hello')
  assert.deepEqual(a, ['-p', 'hello', '--model', 'opus', '--effort', 'medium', '--permission-mode', 'plan', '--output-format', 'text'])
  assert.ok(!a.includes('--bare'))
  const dir = mkdtempSync(join(tmpdir(), 'factory-opus-'))
  const log = join(dir, 'log.jsonl')
  const bin = join(dir, 'claude')
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require('fs')
let n = 0
try { n = fs.readFileSync(0).length } catch { n = 0 }
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), pid: process.pid, stdinBytes: n, cwd: process.cwd(), anthropic: 'ANTHROPIC_API_KEY' in process.env, translator: 'ANTHROPIC_TRANSLATOR_API_KEY' in process.env }) + '\\n')
console.log('ok\\nPASS')
`
  )
  chmodSync(bin, 0o755)
  const env = { ...process.env, ANTHROPIC_API_KEY: 'fixture-not-a-key', ANTHROPIC_TRANSLATOR_API_KEY: 'fixture-not-a-key' }
  const one = await runOpus({ cwd: dir, prompt: 'review', env, bin, timeoutMs: 10_000 })
  const two = await runOpus({ cwd: dir, prompt: 'review', env, bin, timeoutMs: 10_000 })
  assert.equal(one.found, true)
  assert.equal(one.code, 0)
  assert.equal(verdict(one.text), 'PASS')
  assert.equal(two.last, 'PASS')
  const rows = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { argv: string[]; pid: number; stdinBytes: number; anthropic: boolean; translator: boolean })
  assert.equal(rows.length, 2)
  assert.notEqual(rows[0].pid, rows[1].pid)
  for (const r of rows) {
    assert.equal(r.argv[1], 'review')
    assert.equal(r.stdinBytes, 0)
    assert.equal(r.anthropic, false)
    assert.equal(r.translator, false)
  }
  const gone = await runOpus({ cwd: dir, prompt: 'x', env, bin: null, timeoutMs: 1000 })
  assert.equal(gone.found, false)
  const enoent = await runOpus({ cwd: dir, prompt: 'x', env, bin: join(dir, 'nope'), timeoutMs: 1000 })
  assert.equal(enoent.found, false)
})

test('opus effort: medium by default (T2), high on request (T3); never xhigh', () => {
  const med = opusArgs('x')
  assert.equal(med[med.indexOf('--effort') + 1], 'medium')
  const high = opusArgs('x', 'high')
  assert.equal(high[high.indexOf('--effort') + 1], 'high')
  assert.equal(high[high.indexOf('--permission-mode') + 1], 'plan')
  assert.ok(!high.includes('xhigh'))
})
