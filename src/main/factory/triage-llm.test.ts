import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ensureShims, factoryEnv } from './gates.ts'
import { triage } from './triage.ts'
import { grokTriageArgs, llmTriage, mergeTriage, parseLlmTriage } from './triage-llm.ts'

const dir = mkdtempSync(join(tmpdir(), 'factory-tllm-'))
const log = join(dir, 'log.jsonl')
function fake(name: string, body: string): string {
  const p = join(dir, name)
  writeFileSync(p, `#!/usr/bin/env node\nconst fs = require('fs')\nfs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), anthropic: 'ANTHROPIC_API_KEY' in process.env, translator: 'ANTHROPIC_TRANSLATOR_API_KEY' in process.env }) + '\\n')\n${body}\n`)
  chmodSync(p, 0o755)
  return p
}
const env = factoryEnv({ ...process.env, ANTHROPIC_API_KEY: 'fixture-not-a-key', ANTHROPIC_TRANSLATOR_API_KEY: 'fixture-not-a-key' }, ensureShims(join(dir, 'bin')))
const parseLine = (l: string) => {
  try {
    const o = JSON.parse(l) as { type?: string; data?: string }
    return o.type === 'text' ? { kind: 'text', data: o.data } : null
  } catch {
    return null
  }
}

const rulesT1 = { ...triage('Fix the date shown one day off in the order list') }

test('merge is raise-only and may raise to T3', () => {
  assert.equal(rulesT1.size, 'T1')
  assert.equal(rulesT1.risk, 'none')
  const low = mergeTriage(rulesT1, { size: 'T0', risk: 'none', reason: 'tiny' })
  assert.equal(low.size, 'T1')
  assert.equal(low.risk, 'none')
  const up = mergeTriage(rulesT1, { size: 'T2', risk: 'critical', reason: 'touches auth' })
  assert.equal(up.size, 'T2')
  assert.equal(up.risk, 'critical')
  const t3 = mergeTriage(rulesT1, { size: 'T3', risk: 'none', reason: 'rewrite' })
  assert.equal(t3.size, 'T3')
  assert.equal(t3.original, 'T3')
  assert.equal(t3.capped, false)
  const none = mergeTriage(rulesT1, null, 'timed out after 8 s')
  assert.equal(none.size, 'T1')
  assert.ok(none.reasons.some((r) => r === 'Model triage skipped: timed out after 8 s.'))
})

test('parse takes the last valid JSON object', () => {
  assert.deepEqual(parseLlmTriage('thinking {"size":"T1","risk":"none","reason":"a"} then {"size":"t2","risk":"Elevated","reason":"b"}'), { size: 'T2', risk: 'elevated', reason: 'b' })
  assert.equal(parseLlmTriage('no json here'), null)
  assert.equal(parseLlmTriage('{"size":"T9","risk":"none"}'), null)
})

test('argv has --effort low and no --always-approve', () => {
  const a = grokTriageArgs('hi')
  assert.equal(a[0], '-p')
  assert.equal(a[1], 'hi')
  assert.equal(a[a.indexOf('--effort') + 1], 'low')
  assert.ok(!a.includes('--always-approve'))
  assert.ok(a.includes('streaming-json'))
})

test('a grok that sleeps is killed at timeoutMs and rules are kept', async () => {
  const bin = fake('sleepy', 'setTimeout(() => {}, 20000)')
  const t0 = Date.now()
  const r = await llmTriage({ task: 'x', rules: rulesT1, cwd: dir, env, bin, timeoutMs: 1500, parseLine })
  assert.ok(Date.now() - t0 < 6000)
  assert.equal(r.llm, null)
  assert.match(r.why, /timed out/)
  assert.equal(mergeTriage(rulesT1, r.llm, r.why).size, 'T1')
})

test('junk output keeps rules; good output is read through the line parser', async () => {
  const junk = await llmTriage({ task: 'x', rules: rulesT1, cwd: dir, env, bin: fake('junk', 'console.log("not json at all")'), parseLine })
  assert.equal(junk.llm, null)
  const good = await llmTriage({
    task: 'x',
    rules: rulesT1,
    cwd: dir,
    env,
    bin: fake('good', `console.log(JSON.stringify({ type: 'text', data: '{"size":"T2","risk":"elevated","reason":"new route"}' }))`),
    parseLine
  })
  assert.deepEqual(good.llm, { size: 'T2', risk: 'elevated', reason: 'new route' })
  const missing = await llmTriage({ task: 'x', rules: rulesT1, cwd: dir, env, bin: null })
  assert.equal(missing.llm, null)
  const rows = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { argv: string[]; anthropic: boolean; translator: boolean })
  assert.ok(rows.length >= 2)
  for (const row of rows) {
    assert.equal(row.anthropic, false)
    assert.equal(row.translator, false)
    assert.ok(!row.argv.includes('--always-approve'))
    assert.equal(row.argv[row.argv.indexOf('--effort') + 1], 'low')
  }
})
