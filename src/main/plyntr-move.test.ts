import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { AB_OWNS_PLYNTR, gitCredentialForMode } from './watcher-choice.ts'
import { parseSyncManifest } from './sync-manifest-parse.ts'
import {
  MOVE_DONE,
  folderCanMoveToPlyntr,
  runPlyntrMove,
  writePlyntrSyncFile
} from './plyntr-move.ts'

const repo = 'acme/acme-brain'

test('move is only for Joe on an agency folder that is not already plyntr', () => {
  assert.equal(folderCanMoveToPlyntr({ joe: true, syncMode: 'agency-brain', mini: false, hasMarker: true }), true)
  assert.equal(folderCanMoveToPlyntr({ joe: true, syncMode: null, mini: false, hasMarker: true }), true)
  assert.equal(folderCanMoveToPlyntr({ joe: true, syncMode: 'plyntr', mini: false, hasMarker: true }), false)
  assert.equal(folderCanMoveToPlyntr({ joe: false, syncMode: null, mini: false, hasMarker: true }), false)
  assert.equal(folderCanMoveToPlyntr({ joe: true, syncMode: null, mini: true, hasMarker: true }), false)
  assert.equal(folderCanMoveToPlyntr({ joe: true, syncMode: null, mini: false, hasMarker: false }), false)
})

test('a moved folder syncs with the plyntr git token, not ads2ai', () => {
  const dir = mkdtempSync(join(tmpdir(), 'plyntr-move-'))
  try {
    writePlyntrSyncFile(dir, repo, '2026-09-22T00:00:00.000Z')
    const raw = JSON.parse(readFileSync(join(dir, '.team-config', 'sync.json'), 'utf8')) as unknown
    const parsed = parseSyncManifest(raw, `https://github.com/${repo}.git`)
    assert.equal(parsed.ok, true)
    if (parsed.ok) {
      assert.equal(parsed.manifest.mode, 'plyntr')
      assert.equal(parsed.manifest.githubApp, 'plyntr-brain-sync')
      assert.equal(gitCredentialForMode(parsed.manifest.mode), 'plyntr')
    }
    assert.equal(gitCredentialForMode('agency-brain'), 'ads2ai')
    assert.equal(gitCredentialForMode(null), 'ads2ai')
    const src = readFileSync(new URL('./brain-sync.ts', import.meta.url), 'utf8')
    assert.match(src, /gitCredentialForMode/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Agency Brain watching refuses the move before sync starts', async () => {
  let started = 0
  let wrote = 0
  let held = 0
  let issued = 0
  const step = await runPlyntrMove({
    joe: true,
    syncMode: 'agency-brain',
    mini: false,
    hasMarker: true,
    abWatching: () => true,
    repo,
    installed: async () => true,
    issueToken: async () => {
      issued += 1
      return { brainId: 'b1', hasToken: true }
    },
    openInstall: () => {},
    writeManifest: () => {
      wrote += 1
    },
    remember: () => {},
    holdSync: () => {
      held += 1
    },
    startSync: () => {
      started += 1
    }
  })
  assert.equal(step.ok, false)
  assert.equal(step.detail, AB_OWNS_PLYNTR)
  assert.equal(step.startedSync, false)
  assert.equal(started, 0)
  assert.equal(wrote, 0)
  assert.equal(issued, 0)
  assert.equal(held, 0)
})

test('move writes plyntr sync.json and starts sync only after Agency Brain is clear', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'plyntr-move-'))
  let started = 0
  let held = 0
  try {
    const step = await runPlyntrMove({
      joe: true,
      syncMode: null,
      mini: false,
      hasMarker: true,
      abWatching: () => false,
      repo,
      installed: async () => true,
      issueToken: async () => ({ brainId: 'dry-brain', hasToken: true }),
      openInstall: () => {
        throw new Error('install should stay closed when GitHub is already ready')
      },
      writeManifest: () => writePlyntrSyncFile(dir, repo, '2026-09-22T00:00:00.000Z'),
      remember: () => {},
      holdSync: () => {
        held += 1
      },
      startSync: () => {
        started += 1
      }
    })
    assert.equal(step.ok, true)
    assert.equal(step.detail, MOVE_DONE)
    assert.equal(step.startedSync, true)
    assert.equal(started, 1)
    assert.equal(held, 0)
    const raw = JSON.parse(readFileSync(join(dir, '.team-config', 'sync.json'), 'utf8')) as { mode?: string }
    assert.equal(raw.mode, 'plyntr')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('if Agency Brain starts watching after the file is written, sync does not start', async () => {
  let checks = 0
  let started = 0
  let wrote = 0
  let held = 0
  const step = await runPlyntrMove({
    joe: true,
    syncMode: 'agency-brain',
    mini: false,
    hasMarker: true,
    abWatching: () => {
      checks += 1
      return checks >= 3
    },
    repo,
    installed: async () => true,
    issueToken: async () => ({ brainId: 'b1', hasToken: true }),
    openInstall: () => {},
    writeManifest: () => {
      wrote += 1
    },
    remember: () => {},
    holdSync: () => {
      held += 1
    },
    startSync: () => {
      started += 1
    }
  })
  assert.equal(wrote, 1)
  assert.equal(step.wroteManifest, true)
  assert.equal(step.startedSync, false)
  assert.equal(step.detail, AB_OWNS_PLYNTR)
  assert.equal(started, 0)
  assert.equal(held, 1)
})

test('a failed GitHub install does not write the Plyntr manifest', async () => {
  let wrote = 0
  await assert.rejects(
    () =>
      runPlyntrMove({
        joe: true,
        syncMode: null,
        mini: false,
        hasMarker: true,
        abWatching: () => false,
        repo,
        installed: async () => false,
        issueToken: async () => ({ brainId: 'b1', hasToken: true }),
        openInstall: async () => {
          throw new Error('GitHub did not confirm the organization acme.')
        },
        writeManifest: () => {
          wrote += 1
        },
        remember: () => {},
        holdSync: () => {},
        startSync: () => {}
      }),
    /GitHub did not confirm the organization acme/
  )
  assert.equal(wrote, 0)
})
