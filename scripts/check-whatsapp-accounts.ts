// More than one WhatsApp in Brain's browser, end to end. Bundles scripts/in-app-browser/accounts-check.ts and runs it
// twice under this repo's Electron on one temp userData (phase two proves each account's login survives a restart).
// node --experimental-strip-types scripts/check-whatsapp-accounts.ts   Prints WHATSAPP_ACCOUNTS_PASS.
// With --real it opens the real web.whatsapp.com as main and as india instead. Prints WHATSAPP_REAL_PASS.
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

const real = process.argv.includes('--real')
const outDir = join(root, 'node_modules', '.cache', 'whatsapp-accounts-check')
mkdirSync(outDir, { recursive: true })
const bundle = join(outDir, real ? 'accounts-real.mjs' : 'accounts-check.mjs')
await esbuild.build({
  entryPoints: [join(root, 'scripts', 'in-app-browser', real ? 'accounts-real.ts' : 'accounts-check.ts')],
  bundle: true,
  outfile: bundle,
  format: 'esm',
  platform: 'node',
  packages: 'external',
  logLevel: 'error'
})

const userData = mkdtempSync(join(tmpdir(), 'wa-accounts-'))
if (real) {
  const ran = spawnSync(electron, [bundle], { stdio: 'inherit', env: { ...process.env, BB_USERDATA: userData, BB_ROOT: root }, timeout: 3 * 60_000 })
  process.exit(ran.status ?? 1)
}
const trace = join(root, 'plans', '20261009-whatsapp-accounts-check.txt')
for (const phase of ['1', '2']) {
  const ran = spawnSync(electron, [bundle], {
    stdio: 'inherit',
    env: { ...process.env, BB_PHASE: phase, BB_USERDATA: userData, BB_ROOT: root, BB_TRACE: trace },
    timeout: 10 * 60_000
  })
  if (ran.status !== 0) {
    console.log(`WHATSAPP_ACCOUNTS_FAIL phase ${phase} exited ${ran.status ?? ran.signal}`)
    process.exit(1)
  }
}
const lines = readFileSync(trace, 'utf8')
if (!/PHASE_1_PASS/.test(lines) || !/PHASE_2_PASS/.test(lines)) {
  console.log('WHATSAPP_ACCOUNTS_FAIL a phase did not finish')
  process.exit(1)
}
console.log('WHATSAPP_ACCOUNTS_PASS')
