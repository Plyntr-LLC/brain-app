import assert from 'node:assert/strict'
import test from 'node:test'
import { PLYNTR_PACKAGE, plyntrPackageCopy } from './plyntr-package.ts'

test('the Plyntr package is the seat caps, with no checkout', () => {
  assert.equal(PLYNTR_PACKAGE.builders, 2)
  assert.equal(PLYNTR_PACKAGE.team, 10)
  assert.equal(PLYNTR_PACKAGE.projectCap, null)
  const copy = plyntrPackageCopy()
  assert.match(copy, /2 builders/)
  assert.match(copy, /10 agency team/)
  assert.match(copy, /no numeric cap/)
  assert.equal(/stripe|checkout|card/i.test(copy), false)
})
