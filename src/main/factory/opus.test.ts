import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { opusArgs, REVIEW_MAX, reviewAccept, runOpus, STRICT_SKILL_PATH, strictNeeded, strictPrompt, verdict } from './opus.ts'

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
  assert.ok(p.trimEnd().endsWith('End with two lines: GAPS: <n> (how many gaps you found), then exactly PASS or FAIL. PASS only with GAPS: 0.'))
  assert.match(p, /Any gap is FAIL: nits, non-blockers, and follow-ups count as gaps\./)
  if (existsSync(STRICT_SKILL_PATH)) {
    const head = readFileSync(STRICT_SKILL_PATH, 'utf8').slice(0, 200)
    assert.ok(!p.includes(head))
  }
})

test('strict prompt carries the verify results', () => {
  const p = strictPrompt({
    task: 'fix it', tier: 'T2', risk: 'none', base: 'abc123', diff: '+x', workRepo: '/x/site',
    verify: [{ script: 'typecheck', status: 'pass' }, { script: 'test', status: 'fail', tail: 'not ok 1 - src/send.ts' }, { script: 'e2e', status: 'skipped' }]
  })
  assert.match(p, /npm run typecheck: pass/)
  assert.match(p, /npm run test: fail\nnot ok 1 - src\/send\.ts/)
  assert.ok(!p.includes('npm run e2e'))
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

test('opus effort is always medium; never high or xhigh', () => {
  const a = opusArgs('x')
  assert.equal(a[a.indexOf('--effort') + 1], 'medium')
  assert.equal(a[a.indexOf('--permission-mode') + 1], 'plan')
  assert.ok(!a.includes('high'))
  assert.ok(!a.includes('xhigh'))
})

test('reviewAccept: gaps are never a PASS', () => {
  assert.equal(REVIEW_MAX, 5)
  assert.deepEqual(reviewAccept('Looks right.\nGAPS: 0\nPASS'), { status: 'pass', gaps: 0, why: '' })
  assert.equal(reviewAccept('**GAPS: 0**\n**PASS**').status, 'pass')
  assert.deepEqual(reviewAccept('ok\nPASS'), { status: 'fail', gaps: null, why: 'PASS without GAPS: 0' })
  assert.equal(reviewAccept('a.ts:3 off by one\nGAPS: 1\nPASS').why, 'PASS named gaps')
  for (const body of ['One nit: rename x.', 'Nits: spacing.', 'A non-blocker at a.ts:2.', 'This is not a blocker.', 'Leave it for later.', 'An optional follow-up.', 'Follow-up: add a test.', 'A follow up for later.']) {
    const r = reviewAccept(`${body}\nGAPS: 0\nPASS`)
    assert.equal(r.status, 'fail', body)
    assert.equal(r.why, 'PASS named gaps', body)
  }
  for (const body of ['No nits.', 'Nits: none.', 'No non-blockers.', 'No nits, non-blockers, or follow-ups.', 'No nits or non-blockers remain.', 'Nothing to leave for later.', 'No non-blocking issues.', 'No nitpicks.', 'No nitpicks or non-blocking issues.']) {
    assert.deepEqual(reviewAccept(`${body}\nGAPS: 0\nPASS`), { status: 'pass', gaps: 0, why: '' }, body)
  }
  assert.equal(reviewAccept('nit: missing test\nGAPS: 0\nPASS').why, 'PASS named gaps')
  assert.equal(reviewAccept('No nits in a.ts, but one nit: missing test.\nGAPS: 0\nPASS').why, 'PASS named gaps')
  for (const body of ['No nits, but one nit: missing test.', 'No nits, non-blocker: rename x.', 'Nothing blocking; leave the retry for later.', 'Nothing to leave for later, but leave it for later: docs.', 'No nits. Non-blocking: rename x.', 'There are no nits here; one nitpick: rename x', 'One nitpick: rename x.', 'A non-blocking issue at a.ts:2.', 'No nitpick: rename x.', 'No nits: rename x.', 'No non-blockers: rename x.', 'No nits except rename x in a.ts:3.', 'No follow-ups other than adding a test for b.ts.', 'No nits besides one: rename x.', 'No non-blockers apart from the missing test.', 'No nits, except that the label should be lowercase.', 'No follow-ups needed except a docs note.', 'We can leave the retry logic in b.ts for later.', 'Retry handling can be left for later.', "I'd leave that for a later PR.", 'Nothing to leave for later except the docs.', 'No nits; except rename x.', 'No nits. Except rename x.', 'No nits.\nExcept rename x.', 'No nits, but rename x.', 'No follow-up needed but add a test later.', 'Nits: none, but rename x.']) {
    assert.equal(reviewAccept(`${body}\nGAPS: 0\nPASS`).why, 'PASS named gaps', body)
  }
  for (const body of ['No nits, however rename x.', 'No nits. However, rename x.', 'No nits, though I would rename x.', 'No nits, yet rename x.', 'No nits; that said, rename x.', 'No nits, only rename x.', 'No nits, just rename x.', 'No nits. Still, rename x.', 'No follow-ups, although a test would help.', 'No nits, nevertheless rename x.', 'No nits, nonetheless the label is wrong.', 'No nits, instead rename x.', 'No nits, meanwhile rename x.', 'No nits, save for rename x.', 'No nits aside from rename x.', 'Except rename x, no nits.']) {
    assert.equal(reviewAccept(`${body}\nGAPS: 0\nPASS`).why, 'PASS named gaps', body)
  }
  // A none is only a none when it is the whole sentence; "no other / further / more / remaining" is not a none.
  for (const body of ['Rename x in a.ts:3, no other nits.', 'a.ts:3 should rename x; otherwise no nits.', 'Add a test for b.ts later, no other follow-ups needed.', 'I have no nits, non-blockers, or follow-ups.', 'Clean, no follow-ups needed.', 'Correct without nits.', 'No other nits.', 'No further follow-ups.', 'No more nits.', 'No remaining non-blockers.', 'One nitpicking point: rename x.', 'Nitpicky: rename x.', 'Some nitpicking at a.ts:3.']) {
    assert.equal(reviewAccept(`${body}\nGAPS: 0\nPASS`).why, 'PASS named gaps', body)
  }
  for (const body of ['No follow-ups needed.', 'No nits. Looks good.']) {
    assert.deepEqual(reviewAccept(`${body}\nGAPS: 0\nPASS`), { status: 'pass', gaps: 0, why: '' }, body)
  }
  assert.equal(reviewAccept('bug\nGAPS: 2\nFAIL').status, 'fail')
  assert.deepEqual(reviewAccept('a.ts:3 bug\nGAPS: 2\nGAPS: 0\nPASS'), { status: 'fail', gaps: 2, why: 'PASS named gaps' })
  assert.equal(reviewAccept('GAPS: 1\nNo nits.\nGAPS: 0\nPASS').why, 'PASS named gaps')
  assert.equal(reviewAccept('bug\nGAPS: 0\nFAIL').why, 'FAIL')
  assert.equal(reviewAccept('GAPS: 0\nPASS\nbut wait').status, 'fail')
  assert.equal(reviewAccept('').status, 'fail')
})
