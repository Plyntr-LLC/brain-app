// Brain's browser, phase B2, end to end: pop-ups, the page guard, site asks (camera, microphone, clipboard) and the
// passkey gate. Bundles scripts/browser-popups/electron-check.ts and runs it under Electron.
// node --experimental-strip-types scripts/check-browser-popups.ts   Prints BROWSER_POPUPS_PASS.
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const esbuild = require('esbuild') as typeof import('esbuild')
const electron = require('electron') as unknown as string
const out = join(root, 'node_modules', '.cache', 'browser-popups-check')
mkdirSync(out, { recursive: true })
const bundle = join(out, 'electron-check.mjs')
await esbuild.build({ entryPoints: [join(root, 'scripts', 'browser-popups', 'electron-check.ts')], bundle: true, outfile: bundle, format: 'esm', platform: 'node', packages: 'external', logLevel: 'error' })
const ran = spawnSync(electron, [bundle], { stdio: 'inherit', env: { ...process.env, BB_USERDATA: mkdtempSync(join(tmpdir(), 'bp-')), BB_ROOT: root }, timeout: 12 * 60_000 })
const trace = readFileSync(join(root, 'plans', '20261009-browser-popups-check.txt'), 'utf8')
if (ran.status !== 0 || !/BROWSER_POPUPS_PASS/.test(trace)) {
  console.log(`BROWSER_POPUPS_FAIL exited ${ran.status ?? ran.signal}`)
  process.exit(1)
}
console.log('BROWSER_POPUPS_PASS')
