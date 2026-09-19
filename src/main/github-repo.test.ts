import assert from 'node:assert/strict'
import test from 'node:test'
import { parseGithubHqRepo, parseGithubOrgLogin } from './github-repo.ts'

test('parseGithubHqRepo accepts owner/name and git remotes', () => {
  assert.equal(parseGithubHqRepo('acme-org/acme-hq-brain'), 'acme-org/acme-hq-brain')
  assert.equal(parseGithubHqRepo('https://github.com/acme-org/acme-hq-brain.git'), 'acme-org/acme-hq-brain')
  assert.equal(parseGithubHqRepo('git@github.com:acme-org/acme-hq-brain.git'), 'acme-org/acme-hq-brain')
  assert.equal(
    parseGithubHqRepo('https://x-access-token:tok@github.com/acme-org/acme-hq-brain'),
    'acme-org/acme-hq-brain'
  )
  assert.equal(parseGithubHqRepo('https://gitlab.com/acme/brain.git'), '')
  assert.equal(parseGithubHqRepo(''), '')
})

test('parseGithubOrgLogin takes a name, @name, or github.com address', () => {
  assert.equal(parseGithubOrgLogin('harolds-books'), 'harolds-books')
  assert.equal(parseGithubOrgLogin('@harolds-books'), 'harolds-books')
  assert.equal(parseGithubOrgLogin('https://github.com/orgs/harolds-books'), 'harolds-books')
  assert.equal(parseGithubOrgLogin('https://github.com/orgs/harolds-books/'), 'harolds-books')
  assert.equal(parseGithubOrgLogin('https://github.com/harolds-books'), 'harolds-books')
  assert.equal(parseGithubOrgLogin('https://github.com/account/organizations/new'), '')
  assert.equal(parseGithubOrgLogin('not a name!!!'), '')
  assert.equal(parseGithubOrgLogin(''), '')
})
