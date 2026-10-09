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

/**
 * The floor electron-updater checks before it offers an update. It compares `os.release()`, the Darwin kernel
 * version (macOS 13 is Darwin 22), with semver, so the yml must carry a Darwin version, never "13.0": that is not
 * semver, the compare throws, and the updater offers the build to every Mac. Read from electron-builder.yml's
 * `mac.minimumSystemVersion` (the macOS floor the app's Info.plist also gets) and turned into Darwin.
 */
function darwinFloorFromConfig(configPath) {
  if (!configPath || !existsSync(configPath)) return ''
  const m = /^\s+minimumSystemVersion:\s*['"]?(\d+)(?:\.\d+)*['"]?\s*$/m.exec(readFileSync(configPath, 'utf8'))
  if (!m) return ''
  const macos = Number(m[1])
  // macOS 11 (Big Sur) is Darwin 20; each major since adds one.
  if (!(macos >= 11)) throw new Error(`minimumSystemVersion ${m[1]} is below macOS 11; there is no Darwin mapping for it here.`)
  return `${macos + 9}.0.0`
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
  const minimum = opts.minimumSystemVersion || darwinFloorFromConfig(opts.configPath)
  if (minimum && !/^\d+\.\d+\.\d+$/.test(minimum)) throw new Error(`minimumSystemVersion must be a Darwin semver like 22.0.0, not ${minimum}`)
  const body = [
    `version: ${version}`,
    'files:',
    `  - url: ${name}`,
    `    sha512: ${sha512}`,
    `    size: ${size}`,
    `path: ${name}`,
    `sha512: ${sha512}`,
    `releaseDate: '${releaseDate}'`,
    ...(minimum ? [`minimumSystemVersion: ${minimum}`] : []),
    ''
  ].join('\n')
  writeFileSync(ymlPath, body)
  return { name, size, sha512, ymlPath }
}

function syncFromRepo(root) {
  const pkg = require(join(root, 'package.json'))
  const zipPath = join(root, 'dist', `Brain-${pkg.version}-mac.zip`)
  const ymlPath = join(root, 'dist', 'latest-mac.yml')
  return writeLatestMacYml({ version: pkg.version, zipPath, ymlPath, configPath: join(root, 'electron-builder.yml') })
}

module.exports = { zipMeta, writeLatestMacYml, syncFromRepo, darwinFloorFromConfig }

if (require.main === module) {
  const root = join(__dirname, '..')
  const out = syncFromRepo(root)
  console.log(`latest-mac.yml matches ${out.name} (${out.size} bytes).`)
}
