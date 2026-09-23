import assert from 'node:assert/strict'
import test from 'node:test'
import { ghCliDetail, orgIdFromGraphql, orgLoginCandidates, parseGithubHqRepo, parseGithubOrgLogin, plyntrRepoFullName, repoIdFromGh, repoOwnerMatchesOrg, resolvePlyntrRepoName } from '../shared/github-org.ts'

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

test('repoIdFromGh accepts one positive integer', () => {
  assert.equal(repoIdFromGh('424242'), 424242)
  assert.equal(repoIdFromGh(' 424242\n'), 424242)
  assert.equal(repoIdFromGh('0'), 0)
  assert.equal(repoIdFromGh('-1'), 0)
  assert.equal(repoIdFromGh('1.5'), 0)
  assert.equal(repoIdFromGh(''), 0)
  assert.equal(repoIdFromGh('id'), 0)
})

test('repoOwnerMatchesOrg requires the repo owner to be that organization', () => {
  assert.equal(repoOwnerMatchesOrg('its-a-test-rosene/rose-wine-brain', 'its-a-test-rosene'), true)
  assert.equal(repoOwnerMatchesOrg('Its-A-Test-Rosene/rose-wine-brain', 'its-a-test-rosene'), true)
  assert.equal(repoOwnerMatchesOrg('Plyntr-LLC/rose-wine-brain', 'its-a-test-rosene'), false)
  assert.equal(repoOwnerMatchesOrg('its-a-test-rosene/rose-wine-brain', 'Plyntr-LLC'), false)
  assert.equal(repoOwnerMatchesOrg('', 'its-a-test-rosene'), false)
})

test('the worker repo name wins over a rebuilt slug', () => {
  assert.equal(
    resolvePlyntrRepoName('org', 'rose-wine', 'its-a-test-rosene/rose-wine-brain'),
    'its-a-test-rosene/rose-wine-brain'
  )
  assert.equal(resolvePlyntrRepoName('its-a-test-rosene', 'rose-wine'), 'its-a-test-rosene/rose-wine-brain')
  assert.equal(resolvePlyntrRepoName('org', 'foo-brain', ''), 'org/foo-brain')
  assert.equal(resolvePlyntrRepoName('org', 'foo', 'not a repo'), 'org/foo-brain')
})

test('missing gh is a real error, not a blank create failure', () => {
  assert.equal(
    ghCliDetail({ bin: null, status: null }),
    'This Mac does not have the GitHub command (gh). Install GitHub CLI and sign in as an owner of the organization.'
  )
  assert.equal(ghCliDetail({ bin: '/opt/homebrew/bin/gh', status: 1, stderr: 'HTTP 404' }), 'HTTP 404')
  assert.match(ghCliDetail({ bin: '/opt/homebrew/bin/gh', status: 1 }), /did not finish \(exit 1\)/)
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
