import { test } from 'node:test'
import assert from 'node:assert/strict'
import { testFeed } from './update-feed.ts'

test('the update rehearsal feed is taken only from a loopback http address', () => {
  assert.equal(testFeed({ BRAIN_TEST_UPDATE_FEED: 'http://127.0.0.1:8123/' }), 'http://127.0.0.1:8123/')
  for (const bad of ['', 'http://127.0.0.1:8123', 'https://127.0.0.1:8123/', 'http://localhost:8123/', 'http://127.0.0.1.evil.com:80/', 'http://example.com:80/', 'http://127.0.0.1:8123/x/'])
    assert.equal(testFeed({ BRAIN_TEST_UPDATE_FEED: bad }), null, bad)
  assert.equal(testFeed({}), null)
})
