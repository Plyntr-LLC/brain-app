import assert from 'node:assert/strict'
import test from 'node:test'
import { helloName } from './login-identity.ts'

const plyntr = { email: 'joe@plyntr.com', name: 'Joe Wine' }

test('helloName uses the Plyntr login, not the test-company member name', () => {
  assert.equal(
    helloName(
      {
        email: 'joe@plyntr.com',
        appEmail: 'joe@plyntr.com',
        name: 'jj ww',
        appName: 'jj ww'
      },
      plyntr
    ),
    'Joe Wine'
  )
  assert.equal(
    helloName({ email: 'joewine2@gmail.com', appEmail: 'joe@plyntr.com', name: 'jj ww' }, plyntr),
    'Joe Wine'
  )
})

test('helloName for anyone else keeps their own login name', () => {
  assert.equal(
    helloName({ email: 'pat@acme.org', appEmail: 'pat@acme.org', name: 'Pat' }, plyntr),
    'Pat'
  )
  assert.equal(helloName({ email: 'pat@acme.org', appName: 'Pat Lee' }, null), 'Pat Lee')
  assert.equal(helloName({ appEmail: 'sam@example.com' }, null), 'sam')
})
