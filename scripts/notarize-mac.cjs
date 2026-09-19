#!/usr/bin/env node
/**
 * Notarize and staple dist/Brain-0.1.0-mac.dmg.
 * Run: doppler run --project plyntr-chat --config prd -- node scripts/notarize-mac.cjs
 * Never prints issuer, key id, or key material.
 */
const { spawnSync } = require('node:child_process')
const { existsSync } = require('node:fs')
const { homedir } = require('node:os')
const { join } = require('node:path')

const root = join(__dirname, '..')
const pkg = require('../package.json')
const dmg = join(root, 'dist', `Brain-${pkg.version}-mac.dmg`)
const key = join(homedir(), '.appstoreconnect/private_keys/AuthKey_Q43V6P7Q24.p8')
const issuer = process.env.ASC_ISSUER_ID || process.env.APP_STORE_CONNECT_ISSUER_ID
const keyId = process.env.ASC_KEY_ID || process.env.APP_STORE_CONNECT_KEY_ID

if (!existsSync(dmg)) {
  console.error('Missing dmg. Run npm run pack:mac first.')
  process.exit(1)
}
if (!existsSync(key)) {
  console.error('Missing App Store Connect API key file.')
  process.exit(1)
}
if (!issuer || !keyId) {
  console.error('Missing ASC_ISSUER_ID / ASC_KEY_ID in the environment.')
  process.exit(1)
}

console.log('Submitting dmg to Apple notarization (this can take several minutes).')
const submit = spawnSync(
  'xcrun',
  ['notarytool', 'submit', dmg, '--key', key, '--key-id', keyId, '--issuer', issuer, '--wait', '--timeout', '20m'],
  { stdio: 'inherit' }
)
if (submit.status) process.exit(submit.status)

console.log('Stapling ticket onto the dmg.')
const staple = spawnSync('xcrun', ['stapler', 'staple', dmg], { stdio: 'inherit' })
if (staple.status) process.exit(staple.status)

const validate = spawnSync('xcrun', ['stapler', 'validate', dmg], { stdio: 'inherit' })
if (validate.status) process.exit(validate.status)
console.log('Notarized and stapled:', dmg)

const zip = join(root, 'dist', `Brain-${pkg.version}-mac.zip`)
if (existsSync(zip)) {
  console.log('Submitting zip for auto-update (cannot staple a zip).')
  const z = spawnSync(
    'xcrun',
    ['notarytool', 'submit', zip, '--key', key, '--key-id', keyId, '--issuer', issuer, '--wait', '--timeout', '20m'],
    { stdio: 'inherit' }
  )
  if (z.status) process.exit(z.status)
}
