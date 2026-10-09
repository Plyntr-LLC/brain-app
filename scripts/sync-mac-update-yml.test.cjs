const assert = require('node:assert/strict')
const { mkdtempSync, writeFileSync, readFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const test = require('node:test')
const { writeLatestMacYml, zipMeta } = require('./sync-mac-update-yml.cjs')

test('latest-mac.yml sha512 and size match the zip on disk, not a stale yml', () => {
  const dir = mkdtempSync(join(tmpdir(), 'brain-yml-'))
  try {
    const zipPath = join(dir, 'Brain-0.0.0-mac.zip')
    const ymlPath = join(dir, 'latest-mac.yml')
    writeFileSync(zipPath, Buffer.from('ab'))
    writeFileSync(
      ymlPath,
      "version: 0.0.0\nfiles:\n  - url: Brain-0.0.0-mac.zip\n    sha512: stale\n    size: 1\npath: Brain-0.0.0-mac.zip\nsha512: stale\nreleaseDate: '2026-01-01T00:00:00.000Z'\n"
    )
    writeFileSync(zipPath, Buffer.from('abcd'))
    const got = writeLatestMacYml({ version: '0.0.0', zipPath, ymlPath })
    const expect = zipMeta(zipPath)
    assert.equal(got.size, 4)
    assert.equal(got.sha512, expect.sha512)
    const yml = readFileSync(ymlPath, 'utf8')
    assert.match(yml, new RegExp(`sha512: ${expect.sha512}`))
    assert.match(yml, /size: 4/)
    assert.match(yml, /releaseDate: '2026-01-01T00:00:00.000Z'/)
    assert.equal((yml.match(/sha512:/g) || []).length, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the macOS floor electron-updater checks survives the rewrite', () => {
  const dir = mkdtempSync(join(tmpdir(), 'brain-yml-'))
  try {
    const zipPath = join(dir, 'Brain-0.0.0-mac.zip')
    const ymlPath = join(dir, 'latest-mac.yml')
    const configPath = join(dir, 'electron-builder.yml')
    writeFileSync(zipPath, Buffer.from('abcd'))
    writeFileSync(ymlPath, "version: 0.0.0\nfiles: []\nminimumSystemVersion: '13.0'\nreleaseDate: '2026-01-01T00:00:00.000Z'\n")
    writeLatestMacYml({ version: '0.0.0', zipPath, ymlPath })
    assert.match(readFileSync(ymlPath, 'utf8'), /^minimumSystemVersion: 13\.0$/m)
    writeFileSync(ymlPath, "version: 0.0.0\nreleaseDate: '2026-01-01T00:00:00.000Z'\n")
    writeFileSync(configPath, 'mac:\n  hardenedRuntime: true\n  minimumSystemVersion: "13.0"\n')
    writeLatestMacYml({ version: '0.0.0', zipPath, ymlPath, configPath })
    assert.match(readFileSync(ymlPath, 'utf8'), /^minimumSystemVersion: 13\.0$/m)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
