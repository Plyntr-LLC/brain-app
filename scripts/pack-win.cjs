#!/usr/bin/env node
/**
 * Build a Windows NSIS installer from this Mac (wine). Unsigned.
 * Authenticode signing waits for a Windows cert and Joe's yes.
 */
const { execFileSync, spawnSync } = require('node:child_process')
const { existsSync } = require('node:fs')
const { join } = require('node:path')

const root = join(__dirname, '..')
process.chdir(root)

execFileSync('npm', ['run', 'typecheck'], { stdio: 'inherit' })
execFileSync('npx', ['electron-vite', 'build'], { stdio: 'inherit' })

process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false'
console.log('Building unsigned Windows installer. Authenticode waits for a Windows cert.')
const r = spawnSync(
  'npx',
  ['electron-builder', '--win', '--x64', '--publish', 'never', '--config.npmRebuild=false'],
  {
    stdio: 'inherit',
    env: process.env
  }
)
if (r.status) process.exit(r.status)

const exe = join(root, 'dist', 'Brain-0.1.0-win.exe')
if (existsSync(exe)) console.log(`One file: ${exe}`)
else console.log('Look in dist/ for the Windows installer.')
