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
