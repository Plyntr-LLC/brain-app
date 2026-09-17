#!/usr/bin/env node
/**
 * Build a Mac .dmg. Does not notarize.
 * Notarize (Apple) waits for Joe. Set BRAIN_APP_NOTARIZE=1 only after he says yes.
 */
const { execFileSync, spawnSync } = require('node:child_process')
const { existsSync } = require('node:fs')
const { join } = require('node:path')

const root = join(__dirname, '..')
process.chdir(root)

if (process.env.BRAIN_APP_NOTARIZE === '1') {
  console.error('Notarize is gated. Joe has not said yes. Unset BRAIN_APP_NOTARIZE.')
  process.exit(1)
}

execFileSync('npm', ['run', 'typecheck'], { stdio: 'inherit' })
execFileSync('npx', ['electron-vite', 'build'], { stdio: 'inherit' })

const ids = spawnSync('security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' })
const match = (ids.stdout || '').match(/Developer ID Application: ([^"]+)/)
const args = ['electron-builder', '--mac', '--publish', 'never']
if (match) {
  process.env.CSC_NAME = match[1]
  console.log(`Signing with Developer ID Application: ${match[1]} (not notarizing).`)
} else {
  process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false'
  args.push('--config.mac.identity=null')
  console.log('No Developer ID Application cert on this Mac. Building an unsigned dmg.')
  console.log('A newbie will need a signed+notarized build. That waits for Joe.')
}

const r = spawnSync('npx', args, { stdio: 'inherit', env: process.env })
if (r.status) process.exit(r.status)

const dmg = join(root, 'dist', 'Brain-0.1.0-mac.dmg')
if (existsSync(dmg)) console.log(`One file: ${dmg}`)
else console.log('Look in dist/ for the .dmg.')
