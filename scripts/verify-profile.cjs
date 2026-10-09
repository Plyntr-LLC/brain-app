#!/usr/bin/env node
/**
 * After a Developer ID pack: the embedded provisioning profile must list the certificate Brain was signed with and
 * name Brain's app ID. Otherwise macOS kills the app at launch (the keychain entitlement needs a matching profile),
 * so the pack fails here instead.
 *
 *   node scripts/verify-profile.cjs dist/mac-arm64/Brain.app
 */
const { createHash } = require('node:crypto')
const { execFileSync } = require('node:child_process')
const { existsSync, mkdtempSync, readFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')

const APP_ID = 'DWYL4KK53B.com.plyntr.brain'

const sha1 = (buf) => createHash('sha1').update(buf).digest('hex')

/** The profile's certificates (SHA-1 of each) and its app identifier, from `security cms -D` output. */
function readProfile(xml) {
  const certs = /<key>DeveloperCertificates<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(xml)
  const hashes = certs ? [...certs[1].matchAll(/<data>([\s\S]*?)<\/data>/g)].map((m) => sha1(Buffer.from(m[1].replace(/\s+/g, ''), 'base64'))) : []
  const id = /<key>com\.apple\.application-identifier<\/key>\s*<string>([^<]*)<\/string>/.exec(xml)
  const expires = /<key>ExpirationDate<\/key>\s*<date>([^<]*)<\/date>/.exec(xml)
  return { certs: hashes, appId: id ? id[1] : '', expires: expires ? expires[1] : '' }
}

/** Why this profile cannot run with this signing certificate, or null when it can. */
function profileProblem(profile, leafSha1, now = new Date()) {
  if (profile.appId !== APP_ID) return `the profile is for ${profile.appId || 'no app ID'}, not ${APP_ID}`
  if (!profile.certs.includes(leafSha1)) return 'the profile does not list the certificate Brain was signed with'
  if (profile.expires && new Date(profile.expires) <= now) return `the profile expired on ${profile.expires}`
  return null
}

function verifyApp(app) {
  const embedded = join(app, 'Contents', 'embedded.provisionprofile')
  if (!existsSync(embedded)) throw new Error(`No provisioning profile in ${app}. Touch ID passkeys need it; macOS would kill this build at launch.`)
  const xml = execFileSync('security', ['cms', '-D', '-i', embedded], { encoding: 'utf8' })
  const dir = mkdtempSync(join(tmpdir(), 'brain-cert-'))
  try {
    execFileSync('codesign', ['-d', `--extract-certificates=${join(dir, 'cert')}`, app], { stdio: 'ignore' })
    const leaf = sha1(readFileSync(join(dir, 'cert0')))
    const problem = profileProblem(readProfile(xml), leaf)
    if (problem) throw new Error(`Brain would be killed at launch: ${problem}.`)
    return readProfile(xml)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

module.exports = { readProfile, profileProblem, verifyApp, APP_ID }

if (require.main === module) {
  const app = process.argv[2]
  if (!app) {
    console.error('usage: node scripts/verify-profile.cjs <Brain.app>')
    process.exit(2)
  }
  try {
    const p = verifyApp(app)
    console.log(`Profile matches the signing certificate and ${APP_ID} (expires ${p.expires}).`)
  } catch (e) {
    console.error(String(e.message || e))
    process.exit(1)
  }
}
