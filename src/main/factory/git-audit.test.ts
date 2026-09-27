import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { sh, tmpRepo } from './test-git.ts'
import { auditTurn, commitRun, diffText, headSha, isClean, numstat, porcelain } from './git-audit.ts'

test('audit lists a brain AGENTS.md write and skips files dirty before the snapshot', () => {
  const brain = tmpRepo('factory-brain-', { 'AGENTS.md': 'rules\n', 'notes.md': 'a\n' })
  const work = tmpRepo('factory-work-', { 'src/a.ts': 'export const a = 1\n' })
  writeFileSync(join(brain, 'notes.md'), 'dirty before\n')
  const before = porcelain(brain)
  const base = headSha(work)
  writeFileSync(join(brain, 'AGENTS.md'), 'rules changed by a native tool\n')
  writeFileSync(join(work, 'src', 'a.ts'), 'export const a = 2\n')
  writeFileSync(join(work, 'src', 'b.ts'), 'export const b = 1\nexport const c = 2\n')
  const audit = auditTurn({ brainPath: brain, workRepo: work, brainBefore: before, base })
  assert.deepEqual(audit.brain, ['AGENTS.md'])
  assert.deepEqual(
    audit.work.map((r) => [r.path, r.added, r.deleted]),
    [
      ['src/a.ts', 1, 1],
      ['src/b.ts', 2, 0]
    ]
  )
  // Dirty-before file that changes again is a turn change.
  writeFileSync(join(brain, 'notes.md'), 'dirty and changed again\n')
  assert.ok(auditTurn({ brainPath: brain, workRepo: work, brainBefore: before, base }).brain.includes('notes.md'))
})

test('commitRun stages only run paths, commits with real git, and leaves the repo clean', () => {
  const work = tmpRepo('factory-commit-', { 'a.md': 'a\n', 'gone.md': 'x\n' })
  const base = headSha(work)
  writeFileSync(join(work, 'a.md'), 'a2\n')
  mkdirSync(join(work, 'new'))
  writeFileSync(join(work, 'new', 'b.md'), 'b\n')
  rmSync(join(work, 'gone.md'))
  const rows = numstat(work, base)
  assert.deepEqual(rows.map((r) => r.path), ['a.md', 'gone.md', 'new/b.md'])
  assert.match(diffText(work, base), /new file new\/b\.md/)
  const sha = commitRun(work, rows.map((r) => r.path), 'Fix typo in footer')
  assert.notEqual(sha, base)
  assert.equal(isClean(work), true)
  assert.equal(sh(work, ['log', '-1', '--format=%s']).trim(), 'Fix typo in footer')
  assert.equal(sh(work, ['remote']).trim(), '')
})

test('isClean is false with an untracked file', () => {
  const work = tmpRepo('factory-clean-')
  assert.equal(isClean(work), true)
  writeFileSync(join(work, 'x.txt'), 'x')
  assert.equal(isClean(work), false)
})
