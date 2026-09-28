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
// lotline-network: `work` (a stopword) unique-contains it, as in the real ~/Projects.
for (const name of ['agency-brain', 'mykennel', 'lotline', 'lotline-network']) {
  execFileSync('/usr/bin/git', ['clone', '-q', tmpRepo('factory-rr-seed-'), join(projects, name)], { stdio: 'ignore' })
}
// What Chat would know them by: README and package.json, written before the first resolve (the alias cache).
const seeded: Record<string, Record<string, string>> = {
  'mail-desk': { 'README.md': '# Mail desk (Plyntr dogfood, slice 1)\n\nReads the Gmail inbox and drafts replies for Joe to send.\n' },
  'gutter-iq': {
    'README.md': '# Gutter IQ\n\nQuotes for gutter installs.\n',
    'package.json': JSON.stringify({ name: 'gutter-iq', description: 'Gutter quotes' })
  },
  'plyntr-chat': { 'package.json': JSON.stringify({ name: 'plyntr-chat', description: 'Plyntr chat widget beside the inbox' }) }
}
for (const [name, files] of Object.entries(seeded)) {
  execFileSync('/usr/bin/git', ['clone', '-q', tmpRepo('factory-rr-seed-', files), join(projects, name)], { stdio: 'ignore' })
}
const gutter = join(projects, 'gutter-iq')

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

test('a folder that is not a git repo is skipped; its name does not let lastRepo steal the task', () => {
  const r = resolveWorkRepo({ task: 'fix the notes page', brainPath: brain, projectsDir: projects, lastRepo: work })
  assert.deepEqual(r, { ok: false, error: NAME_THE_REPO })
  const bare = resolveWorkRepo({ task: 'fix the footer label', brainPath: brain, projectsDir: projects, lastRepo: work })
  assert.ok(bare.ok && same(bare.workRepo, work) && bare.from === 'last', JSON.stringify(bare))
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

test('one of its names finds the repo: folded, unique prefix, unique contains', () => {
  const at = (task: string, extra: Partial<Parameters<typeof resolveWorkRepo>[0]> = {}) =>
    resolveWorkRepo({ task, brainPath: brain, projectsDir: projects, lastRepo: work, ...extra })
  const kennel = at('fix the footer on kennel')
  assert.ok(kennel.ok && same(kennel.workRepo, join(projects, 'mykennel')) && kennel.from === 'name', JSON.stringify(kennel))
  for (const task of ['fix footer in brain app', 'fix footer in brainapp', 'fix footer in brain']) {
    const r = at(task)
    assert.ok(r.ok && same(r.workRepo, app) && r.from === 'name', `${task}: ${JSON.stringify(r)}`)
  }
  const exact = at('fix footer in brain-app')
  assert.ok(exact.ok && same(exact.workRepo, app) && exact.from === 'project', JSON.stringify(exact))
  const lot = at('LotLine header')
  assert.ok(lot.ok && same(lot.workRepo, join(projects, 'lotline')) && lot.from === 'project', JSON.stringify(lot))
  const typo = at('fix typo')
  assert.ok(typo.ok && same(typo.workRepo, work) && typo.from === 'last', JSON.stringify(typo))
  assert.deepEqual(at('fix typo', { lastRepo: undefined }), { ok: false, error: NAME_THE_REPO })
})

test('an ambiguous name is skipped, not picked', () => {
  // "agen" starts agency-brain only; "line" (lotline) comes later in the task.
  const r = resolveWorkRepo({ task: 'update the agen line', brainPath: brain, projectsDir: projects, lastRepo: work })
  assert.ok(r.ok && same(r.workRepo, join(projects, 'agency-brain')) && r.from === 'name', JSON.stringify(r))
  // "rain" is inside brain-app and agency-brain: skipped, and a leftover topic word never takes lastRepo.
  const amb = resolveWorkRepo({ task: 'rain page', brainPath: brain, projectsDir: projects, lastRepo: work })
  assert.deepEqual(amb, { ok: false, error: NAME_THE_REPO })
})

test('a name hit on the brain folder is skipped and does not flip the error', () => {
  const brainIn = join(projects, 'agency-brain')
  const r = resolveWorkRepo({ task: 'agency stuff', brainPath: brainIn, projectsDir: projects })
  assert.deepEqual(r, { ok: false, error: NAME_THE_REPO })
})

test('Joe 2026-09-28: the email system for Plyntr is mail-desk, not the last repo', () => {
  const r = resolveWorkRepo({
    task: "I want to work on the email system that we're doing for Plyntr",
    brainPath: brain,
    projectsDir: projects,
    lastRepo: gutter
  })
  assert.ok(r.ok && same(r.workRepo, join(projects, 'mail-desk')) && r.from === 'name', JSON.stringify(r))
  // `work` unique-contains lotline-network, but it is a stopword: it never picks a folder.
  const workOnly = resolveWorkRepo({ task: 'I want to work on it', brainPath: brain, projectsDir: projects, lastRepo: gutter })
  assert.ok(workOnly.ok && same(workOnly.workRepo, gutter) && workOnly.from === 'last', JSON.stringify(workOnly))
  const typo = resolveWorkRepo({ task: 'fix typo', brainPath: brain, projectsDir: projects, lastRepo: gutter })
  assert.ok(typo.ok && same(typo.workRepo, gutter) && typo.from === 'last', JSON.stringify(typo))
  const rain = resolveWorkRepo({ task: 'rain page', brainPath: brain, projectsDir: projects, lastRepo: gutter })
  assert.deepEqual(rain, { ok: false, error: NAME_THE_REPO })
})

test('README and package.json aliases find a repo; two folders sharing a word is no pick', () => {
  const dog = resolveWorkRepo({ task: 'dogfood inbox tweaks', brainPath: brain, projectsDir: projects, lastRepo: gutter })
  assert.ok(dog.ok && same(dog.workRepo, join(projects, 'mail-desk')) && dog.from === 'name', JSON.stringify(dog))
  const widget = resolveWorkRepo({ task: 'the widget colors', brainPath: brain, projectsDir: projects, lastRepo: gutter })
  assert.ok(widget.ok && same(widget.workRepo, join(projects, 'plyntr-chat')) && widget.from === 'name', JSON.stringify(widget))
  const quotes = resolveWorkRepo({ task: 'quotes', brainPath: brain, projectsDir: projects })
  assert.ok(quotes.ok && same(quotes.workRepo, gutter), JSON.stringify(quotes))
  // "plyntr" is in mail-desk's README and plyntr-chat's name, but plyntr-chat is its only folder: a name hit.
  const plyntr = resolveWorkRepo({ task: 'plyntr', brainPath: brain, projectsDir: projects })
  assert.ok(plyntr.ok && same(plyntr.workRepo, join(projects, 'plyntr-chat')) && plyntr.from === 'name', JSON.stringify(plyntr))
  // "slice" is only an alias word, "widget" another folder's: first unique hit in task order wins.
  const both = resolveWorkRepo({ task: 'slice widget', brainPath: brain, projectsDir: projects })
  assert.ok(both.ok && same(both.workRepo, join(projects, 'mail-desk')), JSON.stringify(both))
  // "inbox" is in mail-desk's README and plyntr-chat's description: skipped, and lastRepo does not steal it.
  assert.deepEqual(resolveWorkRepo({ task: 'inbox tweaks', brainPath: brain, projectsDir: projects, lastRepo: gutter }), { ok: false, error: NAME_THE_REPO })
  // Stopwords never pick through an alias.
  assert.deepEqual(resolveWorkRepo({ task: 'for the', brainPath: brain, projectsDir: projects }), { ok: false, error: NAME_THE_REPO })
})

test('a task that only names the brain is still refused; an exact folder is still project', () => {
  const byName = resolveWorkRepo({ task: 'fix the footer in agency-brain', brainPath: join(projects, 'agency-brain'), projectsDir: projects, lastRepo: gutter })
  assert.deepEqual(byName, { ok: false, error: BRAIN_IS_WORK })
  const exact = resolveWorkRepo({ task: 'fix footer in brain-app', brainPath: brain, projectsDir: projects, lastRepo: gutter })
  assert.ok(exact.ok && same(exact.workRepo, app) && exact.from === 'project', JSON.stringify(exact))
  const kennel = resolveWorkRepo({ task: 'fix the footer on kennel', brainPath: brain, projectsDir: projects, lastRepo: gutter })
  assert.ok(kennel.ok && same(kennel.workRepo, join(projects, 'mykennel')), JSON.stringify(kennel))
})

test('taskPaths reads absolute and ~ paths and drops trailing punctuation', () => {
  assert.deepEqual(taskPaths('see /Users/x/site/a.ts, and ~/Projects/y.', '/Users/me'), ['/Users/x/site/a.ts', '/Users/me/Projects/y'])
  assert.deepEqual(taskPaths('no paths here, just a/b words'), [])
})
