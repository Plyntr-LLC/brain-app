import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { resolveCloudflaredBin, win32CloudflaredCandidates } from './cloudflared-bin.ts'

test('resolveCloudflaredBin returns CLOUDFLARED_BIN when that file runs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'brain-cf-bin-'))
  const bin = join(dir, 'fake-cloudflared')
  writeFileSync(bin, '#!/bin/sh\nexit 0\n')
  chmodSync(bin, 0o755)
  try {
    const env = { ...process.env, CLOUDFLARED_BIN: bin, PATH: dir }
    delete env.Path
    assert.equal(resolveCloudflaredBin({ env, userDataDir: join(dir, 'ud') }), bin)
    assert.equal(
      resolveCloudflaredBin({
        platform: 'win32',
        env: { ...env, PATH: '', Path: '' },
        userDataDir: join(dir, 'ud'),
        home: dir
      }),
      bin
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('windows candidates are cloudflared.exe including WinGet Links', () => {
  const list = win32CloudflaredCandidates(
    {
      ProgramFiles: 'C:\\pf',
      'ProgramFiles(x86)': 'C:\\pf86',
      LOCALAPPDATA: 'C:\\la'
    },
    'C:\\u',
    'C:\\ud'
  )
  assert.equal(list.length > 0, true)
  assert.equal(
    list.every((p) => p.endsWith('cloudflared.exe')),
    true
  )
  assert.equal(
    list.some((p) => p.includes('WinGet') && p.includes('Links')),
    true
  )
})
