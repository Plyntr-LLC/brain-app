// The in-app browser end to end. Bundles scripts/in-app-browser/electron-check.ts and runs it twice under
// this repo's Electron on one temp userData (phase two proves the saved login survives a restart).
// node --experimental-strip-types scripts/check-in-app-browser.ts   Prints IN_APP_BROWSER_PASS.
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

const outDir = join(root, 'node_modules', '.cache', 'in-app-browser-check')
mkdirSync(outDir, { recursive: true })
const bundle = join(outDir, 'electron-check.mjs')
await esbuild.build({
  entryPoints: [join(root, 'scripts', 'in-app-browser', 'electron-check.ts')],
  bundle: true,
  outfile: bundle,
  format: 'esm',
  platform: 'node',
  packages: 'external',
  logLevel: 'error'
})

const userData = mkdtempSync(join(tmpdir(), 'bb-check-'))
const trace = join(root, 'plans', '20261008-inline-browser-check.txt')
for (const phase of ['1', '2']) {
  const ran = spawnSync(electron, [bundle], {
    stdio: 'inherit',
    env: { ...process.env, BB_PHASE: phase, BB_USERDATA: userData, BB_ROOT: root, BB_TRACE: trace },
    timeout: 20 * 60_000
  })
  if (ran.status !== 0) {
    console.log(`IN_APP_BROWSER_FAIL phase ${phase} exited ${ran.status ?? ran.signal}`)
    process.exit(1)
  }
}
const lines = readFileSync(trace, 'utf8')
if (!/PHASE_1_PASS/.test(lines) || !/PHASE_2_PASS/.test(lines)) {
  console.log('IN_APP_BROWSER_FAIL a phase did not finish')
  process.exit(1)
}
console.log('IN_APP_BROWSER_PASS')
