import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { githubAppInstallUrl, githubInstallReady, reuseExistingFolder } from './setup-folder.ts'

test('reuseExistingFolder never returns a different team folder', () => {
  assert.equal(
    reuseExistingFolder({
      slug: 'harolds-books',
      watchingPath: '/Users/joe/Projects/agency-brain',
      watchingSlug: 'plyntr',
      accountFolder: '/Users/joe/Projects/agency-brain',
      accountSlug: 'plyntr'
    }),
    null
  )
  assert.equal(
    reuseExistingFolder({
      slug: 'harolds-books',
      watchingPath: '/Users/joe/Projects/harolds-books-brain',
      watchingSlug: 'harolds-books',
      accountFolder: null,
      accountSlug: null
    }),
    '/Users/joe/Projects/harolds-books-brain'
  )
  assert.equal(
    reuseExistingFolder({
      slug: '',
      watchingPath: '/Users/joe/Projects/agency-brain',
      watchingSlug: 'plyntr',
      accountFolder: null,
      accountSlug: null
    }),
    '/Users/joe/Projects/agency-brain'
  )
})

test('setup does not require Agency Brain.app', () => {
  const src = readFileSync(new URL('./install.ts', import.meta.url), 'utf8')
  assert.equal(/label: 'Agency Brain'/.test(src), false)
  assert.match(src, /currentBrainFolder\(\)/)
  assert.match(src, /id: 'cloudflared'/)
  assert.match(src, /cloudflaredPresent\(\)/)
  assert.match(src, /SUDO_ASKPASS/)
  const ipc = readFileSync(new URL('./ipc-stubs.ts', import.meta.url), 'utf8')
  assert.match(ipc, /clone skipped in dry-run/)
  assert.match(ipc, /switchBrain\(cloned\.dest\)/)
  const clone = readFileSync(new URL('./clone.ts', import.meta.url), 'utf8')
  assert.match(clone, /credential\.helper=/)
  assert.match(clone, /x-access-token:\$\{t\}@/)
  const sync = readFileSync(new URL('./brain-sync.ts', import.meta.url), 'utf8')
  assert.match(sync, /gitSyncAuthed/)
  assert.match(sync, /if \(!sync\.ok\)/)
  assert.match(sync, /lastFolder/)
})

test('githubAppInstallUrl keeps state on installations/new', () => {
  assert.equal(
    githubAppInstallUrl('harolds-books'),
    'https://github.com/apps/agency-brain-sync/installations/new?state=harolds-books'
  )
  assert.equal(
    githubAppInstallUrl('harolds-books', 12345),
    'https://github.com/apps/agency-brain-sync/installations/new?state=harolds-books&suggested_target_id=12345'
  )
  assert.equal(
    githubAppInstallUrl('harolds-books', 0),
    'https://github.com/apps/agency-brain-sync/installations/new?state=harolds-books'
  )
  assert.ok(!githubAppInstallUrl('x', 1).includes('/permissions'))
})

test('githubInstallReady is true when the app is on the team or a repo exists', () => {
  assert.equal(githubInstallReady({ installed: true }), true)
  assert.equal(githubInstallReady({ installed: true, repoUrl: 'https://github.com/acme/brain' }), true)
  assert.equal(githubInstallReady({ repo: 'acme/brain' }), true)
  assert.equal(githubInstallReady({ installed: false }), false)
  assert.equal(githubInstallReady(null), false)
})
