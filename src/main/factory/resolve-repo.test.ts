import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { tmpRepo } from './test-git.ts'
import { gitTop } from './git-audit.ts'
import { realish } from './paths.ts'
import { BRAIN_IS_WORK, NAME_THE_REPO, resolveWorkRepo, taskPaths } from './resolve-repo.ts'

const brain = tmpRepo('factory-rr-brain-', { 'AGENTS.md': '# brain\n' })
const work = tmpRepo('factory-rr-work-', { 'src/a.ts': 'export const a = 1\n' })
const projects = mkdtempSync(join(tmpdir(), 'factory-rr-projects-'))
const app = join(projects, 'brain-app')
execFileSync('/usr/bin/git', ['clone', '-q', tmpRepo('factory-rr-seed-'), app], { stdio: 'ignore' })
mkdirSync(join(projects, 'notes'))

const same = (a: string, b: string) => realish(a) === realish(b)

test('a path in the task wins, even to a file that does not exist yet', () => {
  const r = resolveWorkRepo({ task: `Fix the footer in ${join(work, 'src', 'new-file.ts')}.`, brainPath: brain, projectsDir: projects })
  assert.ok(r.ok && same(r.workRepo, work) && r.from === 'path', JSON.stringify(r))
})

test('fake git: /tmp/work/src/a.ts resolves to /tmp/work with the brain elsewhere', () => {
  const r = resolveWorkRepo({
    task: 'Fix /tmp/work/src/a.ts please',
    brainPath: brain,
    projectsDir: projects,
    isGitRepo: (p) => p.startsWith('/tmp/work') || realish(p).startsWith(realish('/tmp/work')) || p === '/tmp',
    gitTop: () => '/tmp/work'
  })
  assert.ok(r.ok && r.workRepo === '/tmp/work', JSON.stringify(r))
})

test('a Projects folder named in the task resolves', () => {
  const r = resolveWorkRepo({ task: 'fix footer in brain-app', brainPath: brain, projectsDir: projects })
  assert.ok(r.ok && same(r.workRepo, gitTop(app)) && r.from === 'project', JSON.stringify(r))
  const slash = resolveWorkRepo({ task: 'In ~/Projects/brain-app, fix the footer', brainPath: brain, projectsDir: projects, home: '/nowhere' })
  assert.ok(slash.ok && same(slash.workRepo, app), JSON.stringify(slash))
})

test('a folder that is not a git repo is skipped; lastRepo is the fallback', () => {
  const r = resolveWorkRepo({ task: 'fix the notes page', brainPath: brain, projectsDir: projects, lastRepo: work })
  assert.ok(r.ok && same(r.workRepo, work) && r.from === 'last', JSON.stringify(r))
})

test('the brain is never the work repo', () => {
  const byPath = resolveWorkRepo({ task: `edit ${join(brain, 'AGENTS.md')}`, brainPath: brain, projectsDir: projects, lastRepo: work })
  assert.deepEqual(byPath, { ok: false, error: BRAIN_IS_WORK })
  const byLast = resolveWorkRepo({ task: 'fix the label', brainPath: brain, projectsDir: projects, lastRepo: brain })
  assert.deepEqual(byLast, { ok: false, error: BRAIN_IS_WORK })
  const brainThenWork = resolveWorkRepo({ task: `copy ${join(brain, 'AGENTS.md')} into ${join(work, 'src')}`, brainPath: brain, projectsDir: projects })
  assert.ok(brainThenWork.ok && same(brainThenWork.workRepo, work))
})

test('nothing named and no lastRepo gives the name-the-repo error', () => {
  assert.deepEqual(resolveWorkRepo({ task: '', brainPath: brain, projectsDir: projects }), { ok: false, error: NAME_THE_REPO })
  assert.deepEqual(resolveWorkRepo({ task: 'fix typo in footer', brainPath: brain, projectsDir: projects }), { ok: false, error: NAME_THE_REPO })
  assert.deepEqual(resolveWorkRepo({ task: 'fix typo', brainPath: brain, projectsDir: projects, lastRepo: join(projects, 'gone') }), { ok: false, error: NAME_THE_REPO })
})

test('taskPaths reads absolute and ~ paths and drops trailing punctuation', () => {
  assert.deepEqual(taskPaths('see /Users/x/site/a.ts, and ~/Projects/y.', '/Users/me'), ['/Users/x/site/a.ts', '/Users/me/Projects/y'])
  assert.deepEqual(taskPaths('no paths here, just a/b words'), [])
})
