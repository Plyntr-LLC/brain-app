import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { mergeBrainRows, pickActivePath } from './brains-pick.ts'

test('pickActivePath prefers the saved brain over Agency Brain watching', () => {
  const root = join(tmpdir(), 'brain-pick-' + Date.now())
  const saved = join(root, 'acme')
  const watching = join(root, 'plyntr')
  mkdirSync(saved, { recursive: true })
  mkdirSync(watching, { recursive: true })
  try {
    assert.equal(pickActivePath({ saved, watching, account: watching }), saved)
    assert.equal(pickActivePath({ saved: join(root, 'missing'), watching }), watching)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('mergeBrainRows keeps Plyntr first and drops missing folders', () => {
  const root = join(tmpdir(), 'brain-merge-' + Date.now())
  const plyntr = join(root, 'agency-brain')
  const acme = join(root, 'acme-brain')
  mkdirSync(plyntr, { recursive: true })
  mkdirSync(acme, { recursive: true })
  writeFileSync(join(plyntr, 'ok'), '1')
  try {
    const rows = mergeBrainRows([
      { path: acme, name: 'Acme', slug: 'acme' },
      { path: join(root, 'gone'), name: 'Gone', slug: 'gone' },
      { path: plyntr, name: 'Plyntr', slug: 'plyntr' },
      { path: acme, name: 'Acme', slug: 'acme', watching: true }
    ])
    assert.equal(rows.length, 2)
    assert.equal(rows[0].slug, 'plyntr')
    assert.equal(rows[1].slug, 'acme')
    assert.equal(rows[1].watching, true)
    const kept = mergeBrainRows([
      { path: acme, name: 'Acme', slug: 'acme', syncMode: 'plyntr', brainId: 'b1', seatToken: 'pbt_secret' },
      { path: acme, name: 'Acme', slug: 'acme', watching: true }
    ])
    assert.equal(kept[0].syncMode, 'plyntr')
    assert.equal(kept[0].brainId, 'b1')
    assert.equal(kept[0].seatToken, 'pbt_secret')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
