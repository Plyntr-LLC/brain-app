import assert from 'node:assert/strict'
import test from 'node:test'
import { chooseWatcher } from './watcher-choice.ts'

test('plyntr mode never calls activateWatching', () => {
  assert.equal(
    chooseWatcher({ mode: 'plyntr', abInstalled: true, abWatchingPath: false, mini: false }),
    'start'
  )
  assert.equal(
    chooseWatcher({ mode: 'plyntr', abInstalled: true, abWatchingPath: true, mini: false }),
    'blocked'
  )
})

test('local mode never starts a watcher', () => {
  assert.equal(
    chooseWatcher({ mode: 'local', abInstalled: true, abWatchingPath: false, mini: false }),
    'none'
  )
  assert.equal(
    chooseWatcher({ mode: 'local', abInstalled: false, abWatchingPath: true, mini: false }),
    'none'
  )
})

test('agency mode still prefers Agency Brain when that app is installed', () => {
  assert.equal(
    chooseWatcher({ mode: 'agency-brain', abInstalled: true, abWatchingPath: false, mini: false }),
    'activate'
  )
  assert.equal(
    chooseWatcher({ mode: null, abInstalled: true, abWatchingPath: false, mini: false }),
    'activate'
  )
  assert.equal(
    chooseWatcher({ mode: 'agency-brain', abInstalled: false, abWatchingPath: false, mini: false }),
    'start'
  )
  assert.equal(
    chooseWatcher({ mode: 'plyntr', abInstalled: true, abWatchingPath: false, mini: true }),
    'none'
  )
})
