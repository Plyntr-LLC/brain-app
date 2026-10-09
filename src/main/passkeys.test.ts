import { test } from 'node:test'
import assert from 'node:assert/strict'
import './test-resolve.ts'

const { hasPasskeyGroup, PASSKEY_GROUP } = await import('./passkeys.ts')

test('passkeys turn on only when the signature lists Brain\'s passkey group under keychain-access-groups', () => {
  const plist = (body: string) => `<?xml version="1.0"?><plist version="1.0"><dict>${body}</dict></plist>`
  assert.equal(hasPasskeyGroup(plist(`<key>keychain-access-groups</key><array><string>${PASSKEY_GROUP}</string></array>`)), true)
  assert.equal(hasPasskeyGroup(plist('<key>keychain-access-groups</key><array><string>DWYL4KK53B.other</string></array>')), false)
  assert.equal(hasPasskeyGroup(plist(`<key>com.apple.application-identifier</key><string>${PASSKEY_GROUP}</string>`)), false)
  assert.equal(hasPasskeyGroup(''), false)
})
