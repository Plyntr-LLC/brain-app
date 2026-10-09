// The browser picture's controls end to end (Back, Forward, Reload, the address field, uploads, sound, the
// right-click menu, print, downloads). Bundles scripts/browser-controls/electron-check.ts and runs it under Electron.
// node --experimental-strip-types scripts/check-browser-controls.ts   Prints BROWSER_CONTROLS_PASS.
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
const out = join(root, 'node_modules', '.cache', 'browser-controls-check')
mkdirSync(out, { recursive: true })
const bundle = join(out, 'electron-check.mjs')
await esbuild.build({ entryPoints: [join(root, 'scripts', 'browser-controls', 'electron-check.ts')], bundle: true, outfile: bundle, format: 'esm', platform: 'node', packages: 'external', logLevel: 'error' })
const ran = spawnSync(electron, [bundle], { stdio: 'inherit', env: { ...process.env, BB_USERDATA: mkdtempSync(join(tmpdir(), 'bc-')), BB_ROOT: root }, timeout: 10 * 60_000 })
const trace = readFileSync(join(root, 'plans', '20261009-browser-controls-check.txt'), 'utf8')
if (ran.status !== 0 || !/BROWSER_CONTROLS_PASS/.test(trace)) {
  console.log(`BROWSER_CONTROLS_FAIL exited ${ran.status ?? ran.signal}`)
  process.exit(1)
}
console.log('BROWSER_CONTROLS_PASS')
