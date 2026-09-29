import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { ChildProcess } from 'node:child_process'
import { detectProfile } from './profile.ts'
import { factoryTmpDir, setUserDataDir } from './run-store.ts'
import { copyAdds, runVoice, VOICE_CHECK, voiceArgs } from './voice.ts'

const ud = mkdtempSync(join(tmpdir(), 'factory-voice-ud-'))
setUserDataDir(() => ud)
const diff = `diff --git a/README.md b/README.md
--- a/README.md
+++ b/README.md
@@ -1 +1,2 @@
 hello
+We build fast sites for vets.
diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1 +1 @@
-x
+const y = 1
`

type Call = { bin: string; args: string[]; body: string }
function stub(code: number, calls: Call[]) {
  return (bin: string, args: string[]) => {
    const file = String(args.find((a) => a.startsWith('--file='))).slice(7)
    calls.push({ bin, args, body: existsSync(file) ? readFileSync(file, 'utf8') : '' })
    const child = new EventEmitter() as unknown as ChildProcess
    Object.assign(child, { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: () => true })
    setTimeout(() => {
      ;(child.stdout as unknown as EventEmitter).emit('data', Buffer.from(code === 0 ? 'APPROVE\n' : 'REJECT: too salesy\n'))
      ;(child as unknown as EventEmitter).emit('close', code)
    }, 5)
    return child
  }
}

test('copyAdds gives the voice check visible words from HTML, not tags', () => {
  const d = 'diff --git a/page.html b/page.html\n+++ b/page.html\n+<button class="x">Start &amp; go</button>\n+<div>\ndiff --git a/n.md b/n.md\n+++ b/n.md\n+Plain md line\n'
  assert.equal(copyAdds(d), 'Start & go\nPlain md line')
})

test('copyAdds keeps only added lines of copy files', () => {
  assert.equal(copyAdds(diff), 'We build fast sites for vets.')
  assert.equal(copyAdds('new file docs/a.mdx\n+Hi there\n+Second\n'), 'Hi there\nSecond')
})

test('voice args call doppler team-brain dev with the check script', () => {
  assert.deepEqual(voiceArgs('/t/f.txt', 'email', 'client'), ['run', '-p', 'team-brain', '-c', 'dev', '--', 'node', VOICE_CHECK, '--file=/t/f.txt', '--register=email', '--audience=client'])
})

test('exit 2 holds, exit 0 passes, tmp file deleted, missing script skips', async () => {
  const profile = { ...detectProfile('/nowhere'), voice: { on: true } }
  const calls: Call[] = []
  const here = import.meta.filename
  const rej = await runVoice({ runId: 'run-v1', diff, profile, spawnFn: stub(2, calls) as never, checkPath: here })
  assert.equal(rej.status, 'fail')
  assert.match(String(rej.tail), /REJECT/)
  const ok = await runVoice({ runId: 'run-v2', diff, profile, spawnFn: stub(0, calls) as never, checkPath: here })
  assert.equal(ok.status, 'pass')
  assert.equal(calls.length, 2)
  assert.equal(calls[0].bin, 'doppler')
  assert.deepEqual(calls[0].args.slice(0, 8), ['run', '-p', 'team-brain', '-c', 'dev', '--', 'node', VOICE_CHECK])
  assert.ok(calls[0].args.includes('--register=email') && calls[0].args.includes('--audience=client'))
  assert.equal(calls[0].body.trim(), 'We build fast sites for vets.')
  assert.equal(readdirSync(factoryTmpDir()).length, 0)
  const miss = await runVoice({ runId: 'run-v3', diff, profile, spawnFn: stub(0, calls) as never, checkPath: '/nope/check.cjs' })
  assert.equal(miss.status, 'skipped')
  const nocopy = await runVoice({ runId: 'run-v4', diff: '+++ b/src/a.ts\n+x\n', profile, spawnFn: stub(0, calls) as never, checkPath: here })
  assert.equal(nocopy.status, 'skipped')
  assert.equal(calls.length, 2)
})
