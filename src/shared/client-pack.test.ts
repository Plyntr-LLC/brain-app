import assert from 'node:assert/strict'
import test from 'node:test'
import { countedPeople, packLabel, starterBlocksAdd } from './client-pack.ts'

test('starter counts owner scout and team and stops at three', () => {
  const people = [
    { role: 'owner', status: 'active' },
    { role: 'team', status: 'pending' },
    { role: 'project', status: 'active' }
  ]
  assert.equal(countedPeople(people), 2)
  assert.equal(starterBlocksAdd('starter', people, 'team'), null)
  people.push({ role: 'scout', status: 'active' })
  assert.match(String(starterBlocksAdd('starter', people, 'team')), /Starter includes the owner/)
  assert.equal(starterBlocksAdd('starter', people, 'project'), null)
  assert.equal(starterBlocksAdd('standard', people, 'team'), null)
  assert.equal(starterBlocksAdd(null, people, 'team'), null)
  assert.equal(starterBlocksAdd('growth', people, 'owner'), null)
  assert.equal(packLabel('growth'), 'Growth')
  assert.equal(packLabel(''), 'Not set')
})
