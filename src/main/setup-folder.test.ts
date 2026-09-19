import assert from 'node:assert/strict'
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
