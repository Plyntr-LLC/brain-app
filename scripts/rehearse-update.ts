// The real update, rehearsed on this Mac before a build is published: the old Brain (a release zip) takes this
// repo's dist/ build from a feed on 127.0.0.1 (BRAIN_TEST_UPDATE_FEED, src/main/update-feed.ts), Squirrel installs it
// on quit, and the relaunched app must be the new version. Launches Brain twice in a visible window, with a temp HOME,
// temp userData and a scratch brain. Not under sandbox-exec: Squirrel installs through a launchd job, which
// sandbox-exec forbids (CFErrorDomainLaunchd error 4). Squirrel's own staging lives in the real
// ~/Library/Caches/com.plyntr.brain.ShipIt either way.
// node --experimental-strip-types scripts/rehearse-update.ts <old Brain-x.y.z-mac.zip> [--notarized]
// Prints UPDATE_REHEARSAL_PASS. Note: macOS keeps one ShipIt state for Brain's app ID; do not run it while the
// installed Brain is quitting to install an update of its own.
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { copyFileSync, createReadStream, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const real = homedir()
const oldZip = process.argv[2]
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
let failed = false
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  (${String(detail).replace(/\s+/g, ' ').slice(0, 300)})` : ''}`)
  if (!ok) failed = true
  return ok
}
async function until(fn: () => boolean, ms: number) {
  const end = Date.now() + ms
  while (!fn()) {
    if (Date.now() > end) return false
    await sleep(500)
  }
  return true
}
const versionOf = (app: string) => execFileSync('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', join(app, 'Contents', 'Info.plist')], { encoding: 'utf8' }).trim()

if (!oldZip || !existsSync(oldZip)) {
  console.log('usage: node --experimental-strip-types scripts/rehearse-update.ts <old Brain-x.y.z-mac.zip>')
  process.exit(2)
}
const dist = join(root, 'dist')
const yml = readFileSync(join(dist, 'latest-mac.yml'), 'utf8')
const newVersion = /^version:\s*(.+)$/m.exec(yml)?.[1].trim() || ''
const newZip = join(dist, `Brain-${newVersion}-mac.zip`)
if (!existsSync(newZip)) {
  console.log(`No ${newZip}. Pack first.`)
  process.exit(2)
}

const work = mkdtempSync(join(tmpdir(), 'bb-update-'))
const apps = join(work, 'apps')
const home = join(work, 'home')
const userData = join(work, 'userData')
const scratch = join(work, 'scratch-brain')
for (const d of [apps, home, userData, scratch, join(home, '.grok')]) mkdirSync(d, { recursive: true })
writeFileSync(join(scratch, 'AGENTS.md'), '# Scratch brain for the update rehearsal\n')
spawnSync('git', ['init', '-q'], { cwd: scratch })
if (existsSync(join(real, '.grok', 'auth.json'))) copyFileSync(join(real, '.grok', 'auth.json'), join(home, '.grok', 'auth.json'))
writeFileSync(join(userData, 'account.json'), JSON.stringify({ email: 'update-check@plyntr.com', token: 'update-check', name: 'Update Check', role: 'owner', source: 'local', folder: scratch, brains: [] }))
writeFileSync(join(userData, 'brains.json'), JSON.stringify({ active: scratch, rows: [{ path: scratch, name: 'Scratch', slug: 'scratch', watching: false, syncMode: 'local' }] }))

// The old app, unpacked the way Squirrel leaves an install: no quarantine, so it is not translocated.
execFileSync('ditto', ['-x', '-k', oldZip, apps])
const app = join(apps, 'Brain.app')
spawnSync('xattr', ['-dr', 'com.apple.quarantine', app])
const oldVersion = versionOf(app)
console.log(`old ${oldVersion} from ${basename(oldZip)}, new ${newVersion} from dist/`)

const served: string[] = []
const server = createServer((req, res) => {
  const name = decodeURIComponent(new URL(req.url || '/', 'http://x').pathname.slice(1))
  served.push(name)
  const file = join(dist, name)
  if (!/^(latest-mac\.yml|Brain-[\d.]+-mac\.zip(\.blockmap)?)$/.test(name) || !existsSync(file)) {
    res.writeHead(404)
    res.end()
    return
  }
  res.writeHead(200, { 'content-length': statSync(file).size, 'content-type': name.endsWith('.yml') ? 'text/yaml' : 'application/octet-stream' })
  createReadStream(file).pipe(res)
})
await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()))
const feed = `http://127.0.0.1:${(server.address() as { port: number }).port}/`

const launch = () => {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, BRAIN_GROK_LEADER_SOCK: join(home, '.grok', 'leader-update.sock'), BRAIN_TEST_UPDATE_FEED: feed }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.BRAIN_CHAT
  delete env.BRAIN_APP_NO_AUTO_UPDATE
  // The app's output goes to a log in the work folder for when a step fails.
  const out = openSync(join(work, 'app.log'), 'a')
  return spawn(join(app, 'Contents', 'MacOS', 'Brain'), [`--user-data-dir=${userData}`], { env, stdio: ['ignore', out, out] })
}
const quit = async (child: ReturnType<typeof spawn>) => {
  child.kill('SIGTERM')
  await until(() => child.exitCode !== null || child.signalCode !== null, 30_000)
}

try {
  check('the old app runs from the temp folder with no quarantine', !spawnSync('xattr', ['-p', 'com.apple.quarantine', app]).stdout.toString().trim(), app)
  const first = launch()
  const cache = join(home, 'Library', 'Caches', 'brain-app-updater', 'pending')
  const downloaded = await until(() => served.some((s) => s.endsWith('.zip')) && existsSync(cache) && execFileSync('find', [cache, '-name', '*.zip'], { encoding: 'utf8' }).trim() !== '', 180_000)
  check('the old app asked the rehearsal feed and downloaded the new zip', downloaded, served.join(', '))
  // Squirrel fetches the zip again through electron-updater's proxy, checks its signature and stages it. Quit after that.
  const staged = await until(() => {
    try {
      return /Download completed to/.test(readFileSync(join(work, 'app.log'), 'utf8'))
    } catch {
      return false
    }
  }, 180_000)
  check('Squirrel fetched and staged the update', staged)
  await sleep(8000)
  await quit(first)
  const swapped = await until(() => {
    try {
      return versionOf(app) === newVersion
    } catch {
      return false
    }
  }, 180_000)
  check(`Squirrel installed ${newVersion} over ${oldVersion} after quit`, swapped, versionOf(app))
  const second = launch()
  const recorded = await until(() => {
    try {
      return JSON.parse(readFileSync(join(userData, 'last-version.json'), 'utf8')).version === newVersion
    } catch {
      return false
    }
  }, 90_000)
  const path = spawnSync('ps', ['-o', 'comm=', '-p', String(second.pid)], { encoding: 'utf8' }).stdout.trim() || '(not running)'
  check(`the relaunched app is ${newVersion} and runs from the temp folder, not a translocated copy`, recorded && !/AppTranslocation/.test(path), path)
  await sleep(3000)
  check('the new version stays running (macOS did not kill it at launch)', second.exitCode === null && second.signalCode === null)
  await quit(second)
  check('codesign --verify --deep --strict passes on the installed update', spawnSync('codesign', ['--verify', '--deep', '--strict', app]).status === 0)
  if (process.argv.includes('--notarized')) {
    const assess = spawnSync('spctl', ['-a', '-vvv', '-t', 'exec', app], { encoding: 'utf8' })
    check('Gatekeeper accepts the installed update', assess.status === 0, assess.stderr)
  }
} catch (e) {
  check('rehearsal ran', false, String((e as Error)?.stack || e))
} finally {
  if (failed) console.log(`app log: ${join(work, 'app.log')}`)
  server.close()
}
console.log(failed ? 'UPDATE_REHEARSAL_FAIL' : 'UPDATE_REHEARSAL_PASS')
process.exitCode = failed ? 1 : 0
