import assert from 'node:assert/strict'
import test from 'node:test'
import { githubRepo, nextWatch, type GhPoll } from './deploy-watch.ts'

test('githubRepo reads https, git@ and ssh:// github.com remotes and nothing else', () => {
  for (const url of ['https://github.com/acme/site.git', 'https://github.com/acme/site', 'https://x-token:abc@github.com/acme/site.git', 'git@github.com:acme/site.git', 'ssh://git@github.com/acme/site.git', 'ssh://git@github.com:22/acme/site']) {
    assert.deepEqual(githubRepo(url), { owner: 'acme', repo: 'site' }, url)
  }
  for (const url of ['git@github-work:acme/site.git', 'https://gitlab.com/acme/site.git', '/tmp/bare.git', 'https://github.com/acme/site/tree/main', 'https://github.com/acme/..', '']) {
    assert.equal(githubRepo(url), null, url)
  }
})

const empty: GhPoll = { deployments: [], statuses: [], checks: [] }
const o = { sha: 'abc', prod: true, now: 10_000, noneMs: 5_000, stuckMs: 20_000 }

test('without deployments, only a status or check that names a host counts', () => {
  const ci: GhPoll = { ...empty, statuses: [{ context: 'ci/test', state: 'success' }], checks: [{ name: 'lint', status: 'completed', conclusion: 'success' }] }
  assert.deepEqual(nextWatch({ state: 'watching', since: 9_000 }, ci, o), { state: 'watching', since: 9_000 })
  assert.deepEqual(nextWatch({ state: 'watching', since: 0 }, ci, o), { state: 'none', at: 10_000 })
  const netlify: GhPoll = { ...empty, statuses: [{ context: 'netlify/site/deploy-preview', state: 'success', target_url: 'https://site.netlify.app' }] }
  assert.deepEqual(nextWatch({ state: 'watching', since: 9_000 }, netlify, o), { state: 'live', host: 'Netlify', url: 'https://site.netlify.app', at: 10_000 })
  const render: GhPoll = { ...empty, checks: [{ name: 'Deploy', status: 'in_progress', app: { slug: 'render' } }] }
  assert.equal(nextWatch({ state: 'watching', since: 9_000 }, render, o).state, 'building')
})

test('a failed poll never reads as none; with no poll through by the window it is unknown', () => {
  assert.deepEqual(nextWatch({ state: 'watching', since: 9_000 }, null, { ...o, error: 'HTTP 502' }), { state: 'watching', since: 9_000 })
  assert.deepEqual(nextWatch({ state: 'watching', since: 0 }, null, { ...o, error: 'HTTP 502' }), { state: 'unknown', why: 'GitHub did not answer: HTTP 502', at: 10_000 })
  const building = { state: 'building' as const, host: 'Vercel', since: 9_000 }
  assert.deepEqual(nextWatch(building, null, o), building)
})
