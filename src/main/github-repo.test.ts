import assert from 'node:assert/strict'
import test from 'node:test'
import { orgIdFromGraphql, orgLoginCandidates, parseGithubHqRepo, parseGithubOrgLogin, plyntrRepoFullName } from './github-repo.ts'

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
  assert.equal(parseGithubOrgLogin('https://github.com/account/organizations/rose-wine/settings/profile'), 'rose-wine')
  assert.equal(parseGithubOrgLogin('https://github.com/rose-wine/rose-wine-brain'), 'rose-wine')
  assert.equal(parseGithubOrgLogin('not a name!!!'), '')
  assert.equal(parseGithubOrgLogin(''), '')
})

test('a company brain repo is org/slug-brain', () => {
  assert.equal(plyntrRepoFullName('its-a-test-rosene', 'rose-wine'), 'its-a-test-rosene/rose-wine-brain')
  assert.equal(plyntrRepoFullName('https://github.com/orgs/its-a-test-rosene', 'rose-wine-brain'), 'its-a-test-rosene/rose-wine-brain')
  assert.equal(plyntrRepoFullName('not a name', 'rose'), '')
})

test('GraphQL organization id is used when the public API hides the org', () => {
  assert.deepEqual(
    orgIdFromGraphql('{"data":{"organization":{"login":"its-a-test-rosene","databaseId":332862614}}}'),
    { login: 'its-a-test-rosene', id: 332862614 }
  )
  assert.equal(orgIdFromGraphql('{"data":{"organization":null}}'), null)
})

test('org login candidates keep the name, then a short suffix', () => {
  assert.deepEqual(orgLoginCandidates('rose-wine'), ['rose-wine', 'rose-wine-hq', 'rose-wine-co', 'rose-wine-team'])
  assert.deepEqual(orgLoginCandidates('https://github.com/orgs/rose-wine'), [
    'rose-wine',
    'rose-wine-hq',
    'rose-wine-co',
    'rose-wine-team'
  ])
  assert.deepEqual(orgLoginCandidates(''), [])
  assert.deepEqual(orgLoginCandidates('a'.repeat(39)), ['a'.repeat(39)])
})
