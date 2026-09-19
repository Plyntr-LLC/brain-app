import assert from 'node:assert/strict'
import test from 'node:test'
import { parseGithubHqRepo } from './github-repo.ts'

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
