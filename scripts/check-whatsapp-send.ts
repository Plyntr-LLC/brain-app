// WhatsApp sending from a chat and from Desk, end to end against a stand-in WhatsApp. Bundles
// scripts/in-app-browser/send-check.ts and runs it under this repo's Electron on a temp userData.
// node --experimental-strip-types scripts/check-whatsapp-send.ts   Prints WHATSAPP_SEND_PASS.
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

const outDir = join(root, 'node_modules', '.cache', 'whatsapp-send-check')
mkdirSync(outDir, { recursive: true })
const bundle = join(outDir, 'send-check.mjs')
await esbuild.build({
  entryPoints: [join(root, 'scripts', 'in-app-browser', 'send-check.ts')],
  bundle: true,
  outfile: bundle,
  format: 'esm',
  platform: 'node',
  packages: 'external',
  logLevel: 'error'
})

const userData = mkdtempSync(join(tmpdir(), 'wa-send-'))
const ran = spawnSync(electron, [bundle], { stdio: 'inherit', env: { ...process.env, BB_USERDATA: userData, BB_ROOT: root }, timeout: 15 * 60_000 })
const trace = readFileSync(join(root, 'plans', '20261009-whatsapp-send-check.txt'), 'utf8')
if (ran.status !== 0 || !/WHATSAPP_SEND_PASS/.test(trace)) {
  console.log(`WHATSAPP_SEND_FAIL exited ${ran.status ?? ran.signal}`)
  process.exit(1)
}
console.log('WHATSAPP_SEND_PASS')
