const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const test = require('node:test')
const { readProfile, profileProblem, APP_ID } = require('./verify-profile.cjs')

test('the pack fails unless the profile names Brain and lists the signing certificate', () => {
  const cert = Buffer.from('a fake certificate')
  const other = Buffer.from('another certificate')
  const xml = (appId, certs, expires = '2031-09-17T00:00:00Z') =>
    `<plist><dict><key>DeveloperCertificates</key><array>${certs.map((c) => `<data>${c.toString('base64')}</data>`).join('')}</array>` +
    `<key>Entitlements</key><dict><key>com.apple.application-identifier</key><string>${appId}</string></dict>` +
    `<key>ExpirationDate</key><date>${expires}</date></dict></plist>`
  const leaf = createHash('sha1').update(cert).digest('hex')
  const now = new Date('2026-10-09T00:00:00Z')
  assert.equal(profileProblem(readProfile(xml(APP_ID, [other, cert])), leaf, now), null)
  assert.match(profileProblem(readProfile(xml(APP_ID, [other])), leaf, now), /does not list the certificate/)
  assert.match(profileProblem(readProfile(xml('DWYL4KK53B.com.plyntr.other', [cert])), leaf, now), /not DWYL4KK53B\.com\.plyntr\.brain/)
  assert.match(profileProblem(readProfile(xml(APP_ID, [cert], '2026-01-01T00:00:00Z')), leaf, now), /expired/)
})
