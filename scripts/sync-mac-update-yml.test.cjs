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

test('the floor in latest-mac.yml is the Darwin version electron-updater compares, and it turns macOS 12 away', () => {
  const dir = mkdtempSync(join(tmpdir(), 'brain-yml-'))
  try {
    const zipPath = join(dir, 'Brain-0.0.0-mac.zip')
    const ymlPath = join(dir, 'latest-mac.yml')
    const configPath = join(dir, 'electron-builder.yml')
    writeFileSync(zipPath, Buffer.from('abcd'))
    // electron-builder's own "13.0" in an old yml is ignored: it is not semver and would let every Mac update.
    writeFileSync(ymlPath, "version: 0.0.0\nfiles: []\nminimumSystemVersion: '13.0'\nreleaseDate: '2026-01-01T00:00:00.000Z'\n")
    writeFileSync(configPath, 'mac:\n  hardenedRuntime: true\n  minimumSystemVersion: "13.0"\n')
    writeLatestMacYml({ version: '0.0.0', zipPath, ymlPath, configPath })
    const floor = /^minimumSystemVersion: (.+)$/m.exec(readFileSync(ymlPath, 'utf8'))[1]
    assert.equal(floor, '22.0.0')
    // electron-updater's own check: semver.lt(os.release(), minimumSystemVersion) means "not supported".
    const { lt } = require('../node_modules/electron-updater/node_modules/semver/index.js')
    assert.equal(lt('21.6.0', floor), true, 'macOS 12 (Darwin 21) is turned away')
    assert.equal(lt('22.1.0', floor), false, 'macOS 13 (Darwin 22) is offered')
    assert.equal(lt('25.0.0', floor), false, 'macOS 16 is offered')
    assert.throws(() => writeLatestMacYml({ version: '0.0.0', zipPath, ymlPath, minimumSystemVersion: '13.0' }))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
