import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const rootRepo = join(homedir(), 'Projects', 'brain-app')
const FOLDER = '/Users/joewine/Projects/agency-brain'
const CAP = 5368709120
const MARKER = 'LIVE-MARKER-9c2a'

function fail(step: string, why: string): never {
  process.stderr.write(`MEDIA_LIVE_FAIL ${step}: ${why}\n`)
  process.exit(1)
}

if (!process.versions.electron) {
  const buttons = ((): string[] => {
    const src = readFileSync(join(rootRepo, 'src/renderer/src/PlyntrPath.tsx'), 'utf8')
    const m = src.match(/function ForkScreen[\s\S]*?choice-stack([\s\S]*?)<\/div>/)
    if (!m) return []
    return [...m[1].matchAll(/>(Sign in|I have a code|This computer only)</g)].map((x) => x[1])
  })()
  if (buttons.length !== 3) fail('B', 'choice-stack buttons were ' + JSON.stringify(buttons))
  const settingsSrc = readFileSync(join(rootRepo, 'src/renderer/src/SettingsPanel.tsx'), 'utf8')
  if (!settingsSrc.includes('{localSyncOffer()}\n          {mediaStorageOffer()}')) {
    fail('B', 'MediaStoragePanel is not after localSyncOffer')
  }
  const unit = spawnSync('bash', ['-lc', 'node --test --experimental-strip-types src/main/media/*.test.ts'], {
    cwd: rootRepo,
    encoding: 'utf8'
  })
  if (unit.status !== 0) fail('dry-run', unit.stderr || unit.stdout || 'unit tests failed')
  const syncTest = spawnSync('node', ['--test', 'test/media-v1.test.js'], {
    cwd: '/Users/joewine/Projects/brain-sync',
    encoding: 'utf8'
  })
  if (syncTest.status !== 0) fail('dry-run', syncTest.stderr || syncTest.stdout || 'brain-sync media tests failed')
  const cfgPath = join(FOLDER, '.team-config', 'media.json')
  if (existsSync(cfgPath)) {
    const mediaBrainId = String(JSON.parse(readFileSync(cfgPath, 'utf8')).mediaBrainId || '')
    const projTok = `pms_${randomBytes(18).toString('hex')}`
    const hash = createHash('sha256').update(projTok).digest('hex')
    const sql = `INSERT INTO media_seats (id, media_brain_id, email, name, role, roots, token_hash, status, created_at) VALUES ('${randomUUID()}', '${mediaBrainId}', 'live-proj@example.test', 'Live Proj', 'project', '["projects/zzz-other/"]', '${hash}', 'active', datetime('now'))`
    const ins = spawnSync('node', ['/tmp/cf-d1-sql.cjs', sql], { encoding: 'utf8' })
    if (ins.status !== 0) fail('1', 'could not insert project seat')
    process.env.MEDIA_PROJ_TOKEN = projTok
  }
  delete process.env.BRAIN_APP_DRY_RUN
  const require = createRequire(join(rootRepo, 'package.json'))
  const esbuild = require('esbuild') as {
    buildSync: (opts: Record<string, unknown>) => void
  }
  const out = join(tmpdir(), 'check-media-live.cjs')
  esbuild.buildSync({
    entryPoints: [join(rootRepo, 'scripts/check-media-live.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: out,
    external: ['electron'],
    logLevel: 'silent',
    define: {
      'import.meta.url': JSON.stringify('file://' + join(rootRepo, 'scripts/check-media-live.ts'))
    }
  })
  const electron = require('electron') as string
  const r = spawnSync(electron, [out], {
    stdio: 'inherit',
    env: {
      ...process.env,
      BRAIN_APP_DRY_RUN: '',
      ELECTRON_RUN_AS_NODE: '',
      MEDIA_FORK_BUTTONS: String(buttons.length)
    }
  })
  const cfgPath2 = join(FOLDER, '.team-config', 'media.json')
  if (existsSync(cfgPath2)) {
    const mediaBrainId = String(JSON.parse(readFileSync(cfgPath2, 'utf8')).mediaBrainId || '')
    spawnSync(
      'node',
      [
        '/tmp/cf-d1-sql.cjs',
        `DELETE FROM media_seats WHERE email = 'live-proj@example.test' AND media_brain_id = '${mediaBrainId}'`
      ],
      { encoding: 'utf8' }
    )
  }
  process.exit(r.status == null ? 1 : r.status)
}

async function run(): Promise<void> {
const { app } = await import('electron')
process.on('uncaughtException', (err) => {
  process.stderr.write(`MEDIA_LIVE_FAIL run: ${String(err && err.message ? err.message : err)}\n`)
  app.exit(1)
})
app.setPath('userData', join(homedir(), 'Library', 'Application Support', 'brain-app'))
await app.whenReady()
const { initShellVault } = await import('../src/main/shell-vault.ts')
initShellVault(app.getPath('userData'))

const { mediaAdd, mediaDownload, mediaEnable, mediaSetCap, mediaStatus, mediaTurnOnBucket, takePassphrase, takeRecoveryKey } =
  await import('../src/main/media/session.ts')
const { playMedia } = await import('../src/main/media/play.ts')
const { deleteCipherCache } = await import('../src/main/media/cache.ts')
const { readMediaConfig } = await import('../src/main/media/media-config.ts')
const { readLiveSnap } = await import('../src/main/media/live-state.ts')
const { mediaLiveJson, mediaLiveGet } = await import('../src/main/media/live-client.ts')


process.stdout.write('live-check enable\n')
const health = await fetch('https://brain-sync.joe-84a.workers.dev/v1/media/health')
if (health.status !== 200) fail('2', 'health ' + health.status)

mkdirSync(join(FOLDER, 'projects', 'media-live-check'), { recursive: true })
const root = 'projects/media-live-check/'

const cfgBefore = readMediaConfig(FOLDER)
const hadDeviceBefore = Boolean(
  cfgBefore && readLiveSnap(app.getPath('userData'), cfgBefore.mediaBrainId)?.deviceId
)
const enabled = await mediaEnable({
  folder: FOLDER,
  email: 'joe@plyntr.com',
  code: process.env.MEDIA_ENABLE_CODE || undefined
})
process.stdout.write('live-check after-enable\n')
if (!enabled.ok) fail('3', enabled.detail || 'enable failed')
const firstPass = takePassphrase(FOLDER)
const firstRecovery = takeRecoveryKey(FOLDER)
const cfg = readMediaConfig(FOLDER)
if (!cfg || !/^[a-f0-9]{32}$/.test(cfg.mediaBrainId)) fail('3', 'media id is not 32 hex')
// A fresh brain's passphrase and recovery key only exist here. Keep them for Joe, never on stdout.
if (firstPass || firstRecovery) {
  const secretsPath = join(app.getPath('userData'), 'media', cfg.mediaBrainId, 'first-secrets.txt')
  mkdirSync(join(app.getPath('userData'), 'media', cfg.mediaBrainId), { recursive: true })
  writeFileSync(
    secretsPath,
    `Storage passphrase: ${firstPass || '(the one you typed)'}\nRecovery key: ${firstRecovery || '(not shown)'}\n`,
    { mode: 0o600 }
  )
  process.stdout.write(`live-check saved the new passphrase and recovery key to ${secretsPath}\n`)
}
const snap = readLiveSnap(app.getPath('userData'), cfg.mediaBrainId)
if (!snap?.deviceId) fail('3', 'no live device id')
if (!String(snap.bucket || '').includes(cfg.mediaBrainId.slice(0, 24))) fail('3', 'bucket name missing media id')

const projTok = String(process.env.MEDIA_PROJ_TOKEN || '')
if (!projTok) fail('1', 'missing project seat token')
const deniedEnable = await mediaLiveJson({
  method: 'POST',
  path: '/v1/media/brains',
  token: projTok,
  body: { id: randomBytes(16).toString('hex') }
})
if (deniedEnable.status !== 403) fail('4', 'project enable ' + deniedEnable.status)
const deniedCap = await mediaLiveJson({
  method: 'POST',
  path: `/v1/media/brains/${cfg.mediaBrainId}/cap`,
  token: projTok,
  body: { capBytes: CAP }
})
if (deniedCap.status !== 403) fail('4', 'project cap ' + deniedCap.status)

const capFive = await mediaSetCap({ folder: FOLDER, capBytes: CAP })
if (capFive.capBytes !== CAP) fail('5', 'cap was ' + capFive.capBytes)
const bucket = await mediaTurnOnBucket(FOLDER)
if (!bucket.bucket) fail('5', 'bucket off')
const st = await mediaStatus(FOLDER)
if (st.bucketStatus !== 'on') fail('5', 'bucketStatus ' + st.bucketStatus)
if (st.capBytes !== CAP) fail('5', 'status cap ' + st.capBytes)

process.stdout.write('live-check add\n')
const png = join(tmpdir(), 'live-marker.png')
writeFileSync(png, Buffer.concat([randomBytes(64), Buffer.from(MARKER), randomBytes(64)]))
const beforeAdd = await mediaStatus(FOLDER)
writeFileSync(
  join(rootRepo, 'z-logs', 'live-before-add.txt'),
  `cap=${beforeAdd.capBytes} used=${beforeAdd.usedBytes} bucket=${beforeAdd.bucketStatus}\n`
)
let added
try {
  added = await mediaAdd({ folder: FOLDER, root, path: png })
} catch (err) {
  writeFileSync(
    join(rootRepo, 'z-logs', 'live-add-err.txt'),
    `${String(err)} cap=${beforeAdd.capBytes} used=${beforeAdd.usedBytes}\n`
  )
  fail('6', `${String((err as Error).message)} cap=${beforeAdd.capBytes} used=${beforeAdd.usedBytes}`)
}
if (!added.ok) fail('6', added.ok === false ? added.detail : 'add failed')
const mediaId = added.ok ? added.rel : ''
const pointer = readFileSync(join(FOLDER, added.ok ? added.rel : ''), 'utf8')
const idMatch = pointer.match(/media_id:\s*([0-9a-f-]+)/i)
if (!idMatch) fail('6', 'pointer missing media_id')
const objectId = idMatch[1]
const srcSha = createHash('sha256').update(readFileSync(png)).digest('hex')
const played = await playMedia({ folder: FOLDER, mediaId: objectId })
const playSha = createHash('sha256').update(played.bytes).digest('hex')
if (playSha !== srcSha) fail('6', 'play hash mismatch')

const { safeStorage } = await import('electron')
const { readPmsSeat } = await import('../src/main/media/pms-seats.ts')
const pms = readPmsSeat(app.getPath('userData'), cfg.mediaBrainId, safeStorage)
const token = pms?.token || ''
if (!token) fail('7', 'no pms token on this Mac')
const signed = await mediaLiveJson({
  method: 'POST',
  path: `/v1/media/objects/${objectId}/download`,
  token,
  deviceId: snap.deviceId,
  body: {}
})
if (signed.status !== 200 || typeof signed.json.url !== 'string') fail('7', 'presign ' + signed.status)
const remote = await mediaLiveGet(String(signed.json.url))
if (remote.status !== 200 || !remote.body.length) fail('7', 'r2 get ' + remote.status)
const r2Sha = createHash('sha256').update(remote.body).digest('hex')
if (r2Sha === srcSha) fail('7', 'r2 body equals plaintext')
if (remote.body.includes(MARKER)) fail('7', 'marker in r2 object')

deleteCipherCache(app.getPath('userData'), cfg.mediaBrainId, objectId)
const played2 = await playMedia({ folder: FOLDER, mediaId: objectId })
const playSha2 = createHash('sha256').update(played2.bytes).digest('hex')
if (playSha2 !== srcSha) fail('8', 'play after cache clear mismatch')

let overStatus = 0
try {
  const used = (await mediaStatus(FOLDER)).usedBytes
  await mediaSetCap({ folder: FOLDER, capBytes: Math.max(1, used) })
  const bigPath = join(tmpdir(), 'live-over.bin')
  writeFileSync(bigPath, Buffer.alloc(8192, 7))
  const over = await mediaAdd({ folder: FOLDER, root, path: bigPath })
  overStatus = over.ok ? 200 : over.status
} finally {
  const cap = await mediaSetCap({ folder: FOLDER, capBytes: CAP })
  if (cap.capBytes !== CAP) fail('5', 'restore cap was ' + cap.capBytes)
}
if (overStatus !== 413) fail('9', 'over-cap status ' + overStatus)

const projDl = await mediaLiveJson({
  method: 'POST',
  path: `/v1/media/objects/${objectId}/download`,
  token: projTok,
  body: {}
})
if (projDl.status !== 403) fail('10', 'project download ' + projDl.status)
const projGet = await mediaLiveJson({
  method: 'GET',
  path: `/v1/media/objects/${objectId}`,
  token: projTok
})
if (projGet.status !== 403) fail('10', 'project get ' + projGet.status)

if (added.ok) {
  try {
    rmSync(join(FOLDER, added.rel), { force: true })
  } catch {
    /* */
  }
}
const finalSt = await mediaStatus(FOLDER)
const dir = join(rootRepo, 'z-logs', 'media-live')
mkdirSync(dir, { recursive: true })
const stamp = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15)
const artifact = {
  enable: enabled.ok ? 200 : 0,
  enableAlreadyOn: hadDeviceBefore,
  capBytes: finalSt.capBytes,
  bucketStatus: finalSt.bucketStatus,
  playShaMatch: playSha === srcSha,
  playAfterCacheClear: playSha2 === srcSha,
  r2Status: remote.status,
  r2ShaDiffers: r2Sha !== srcSha,
  markerInObject: remote.body.includes(MARKER),
  overCap: overStatus,
  projectEnable: deniedEnable.status,
  projectCap: deniedCap.status,
  projectPlay: projDl.status,
  projectGet: projGet.status,
  dryRun: process.env.BRAIN_APP_DRY_RUN === '1',
  health: health.status,
  forkButtons: Number(process.env.MEDIA_FORK_BUTTONS || 0)
}
writeFileSync(join(dir, `plyntr-${stamp}.json`), `${JSON.stringify(artifact)}\n`)
process.stdout.write('MEDIA_LIVE_PASS\n')
app.quit()
}

void run().catch((err) => {
  process.stderr.write(`MEDIA_LIVE_FAIL run: ${String(err && err.message ? err.message : err)}\n`)
  process.exit(1)
})
