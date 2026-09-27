#!/usr/bin/env node
/**
 * electron-builder sometimes writes latest-mac.yml before the zip is finished.
 * Auto-update then fails sha512. Rewrite the yml from the zip that will be uploaded.
 */
const { createHash } = require('node:crypto')
const { existsSync, readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

function zipMeta(zipPath) {
  const buf = readFileSync(zipPath)
  return {
    size: buf.length,
    sha512: createHash('sha512').update(buf).digest('base64')
  }
}

function releaseDateFrom(ymlPath) {
  if (!existsSync(ymlPath)) return new Date().toISOString()
  const m = readFileSync(ymlPath, 'utf8').match(/releaseDate:\s*'([^']+)'/)
  return m ? m[1] : new Date().toISOString()
}

function writeLatestMacYml(opts) {
  const version = String(opts.version || '')
  const zipPath = String(opts.zipPath || '')
  const ymlPath = String(opts.ymlPath || '')
  if (!version || !zipPath || !ymlPath) throw new Error('version, zipPath, and ymlPath are required.')
  if (!existsSync(zipPath)) throw new Error(`Missing zip: ${zipPath}`)
  const { size, sha512 } = zipMeta(zipPath)
  const name = require('node:path').basename(zipPath)
  const releaseDate = opts.releaseDate || releaseDateFrom(ymlPath)
  const body = [
    `version: ${version}`,
    'files:',
    `  - url: ${name}`,
    `    sha512: ${sha512}`,
    `    size: ${size}`,
    `path: ${name}`,
    `sha512: ${sha512}`,
    `releaseDate: '${releaseDate}'`,
    ''
  ].join('\n')
  writeFileSync(ymlPath, body)
  return { name, size, sha512, ymlPath }
}

function syncFromRepo(root) {
  const pkg = require(join(root, 'package.json'))
  const zipPath = join(root, 'dist', `Brain-${pkg.version}-mac.zip`)
  const ymlPath = join(root, 'dist', 'latest-mac.yml')
  return writeLatestMacYml({ version: pkg.version, zipPath, ymlPath })
}

module.exports = { zipMeta, writeLatestMacYml, syncFromRepo }

if (require.main === module) {
  const root = join(__dirname, '..')
  const out = syncFromRepo(root)
  console.log(`latest-mac.yml matches ${out.name} (${out.size} bytes).`)
}
