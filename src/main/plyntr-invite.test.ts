import assert from 'node:assert/strict'
import test from 'node:test'
import { authCodeRoute, displayPlyntrCode, normalizePlyntrInviteCode, slugFromBusinessName } from '../shared/plyntr-invite.ts'

test('authCodeRoute sends 10-character codes to Plyntr and leaves short codes alone', () => {
  assert.equal(authCodeRoute('TESTTEST12'), 'plyntr')
  assert.equal(authCodeRoute('test-test-12'), 'plyntr')
  assert.equal(authCodeRoute('test test 12'), 'plyntr')
  assert.equal(normalizePlyntrInviteCode('ab-cd ef'), 'ABCDEF')
  assert.equal(authCodeRoute('ABC123'), 'other')
  assert.equal(authCodeRoute('ABC123!'), 'other')
  assert.equal(displayPlyntrCode('TESTTEST12'), 'TEST-TEST-12')
})

test('slugFromBusinessName follows the Path B slug rules', () => {
  assert.equal(slugFromBusinessName("Harold's Books & Co."), 'harolds-books-and-co')
  assert.equal(slugFromBusinessName('  ---  '), '')
  assert.equal(slugFromBusinessName('A'.repeat(50)), 'a'.repeat(40))
})
