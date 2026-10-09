// Electron 44: the clipboard through the real setup paths and node-pty in dev; with --packed, the packed app's
// node-pty and the scripts it runs as Node (the open guard and Desk's mail and text helpers), none of which can send.
// node --experimental-strip-types scripts/check-electron-44.ts [--packed]   Prints ELECTRON_44_PASS.
import { spawnSync } from 'node:child_process'
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const esbuild = require('esbuild') as typeof import('esbuild')
const electron = require('electron') as unknown as string
const trace = join(root, 'plans', '20261009-electron-44-check.txt')
const packed = process.argv.includes('--packed')
if (!packed) writeFileSync(trace, `electron 44 check ${new Date().toISOString()}\n`)
const log = (line: string) => {
  console.log(line)
  appendFileSync(trace, line + '\n')
}
let failed = false
function check(name: string, ok: boolean, detail = '') {
  log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  (${detail.replace(/\s+/g, ' ').slice(0, 200)})` : ''}`)
  if (!ok) failed = true
}

if (!packed) {
  const out = join(root, 'node_modules', '.cache', 'electron-44-check')
  mkdirSync(out, { recursive: true })
  const bundle = join(out, 'electron-check.mjs')
  await esbuild.build({ entryPoints: [join(root, 'scripts', 'electron-44', 'electron-check.ts')], bundle: true, outfile: bundle, format: 'esm', platform: 'node', packages: 'external', logLevel: 'error' })
  const userData = mkdtempSync(join(tmpdir(), 'e44-'))
  const ran = spawnSync(electron, [bundle], { stdio: 'inherit', cwd: root, env: { ...process.env, BB_USERDATA: userData, BB_TRACE: trace, BRAIN_APP_DRY_RUN: '1' }, timeout: 180_000 })
  check('the Electron 44 run finished', ran.status === 0, String(ran.status ?? ran.signal))
} else {
  const app = join(root, 'dist', 'mac-arm64', 'Brain.app', 'Contents')
  const exe = join(app, 'MacOS', 'Brain')
  const res = join(app, 'Resources')
  const work = mkdtempSync(join(tmpdir(), 'e44-packed-'))
  const home = join(work, 'home')
  mkdirSync(home)
  const node = (args: string[], extra: Record<string, string> = {}) =>
    spawnSync(exe, args, { encoding: 'utf8', env: { PATH: process.env.PATH || '', HOME: home, ELECTRON_RUN_AS_NODE: '1', ...extra }, timeout: 60_000 })

  const ptyScript = join(work, 'pty.cjs')
  writeFileSync(ptyScript, "const pty = require(process.argv[2]); const t = pty.spawn('/bin/echo', ['pty-ok'], {}); let out = ''; t.onData((d) => (out += d)); t.onExit((e) => { console.log(e.exitCode === 0 && out.includes('pty-ok') ? 'PTY_OK' : 'PTY_BAD ' + JSON.stringify(out)) })\n")
  const pty = node([ptyScript, join(res, 'app.asar', 'node_modules', 'node-pty')])
  check('packed node-pty spawns through the packed executable', /PTY_OK/.test(pty.stdout), `${pty.stdout} ${pty.stderr}`.slice(0, 200))

  const recorder = join(work, 'open-recorder.sh')
  const record = join(work, 'opened.txt')
  writeFileSync(recorder, `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(record)}\n`)
  chmodSync(recorder, 0o755)
  const refused = node([join(res, 'open-guard.cjs'), 'https://example.com'], { BRAIN_OPEN_BIN: recorder })
  check('the packed open guard refuses a web page', refused.status === 1 && !existsSync(record), `${refused.status} ${refused.stderr}`)
  const file = join(work, 'notes.txt')
  writeFileSync(file, 'x')
  const passed = node([join(res, 'open-guard.cjs'), file], { BRAIN_OPEN_BIN: recorder })
  check('the packed open guard passes a file through', passed.status === 0 && existsSync(record) && readFileSync(record, 'utf8').trim() === file, `${passed.status} ${existsSync(record) ? readFileSync(record, 'utf8') : 'no record'}`)

  const brain = join(work, 'brain')
  mkdirSync(join(brain, 'code', 'imessage', 'lib'), { recursive: true })
  writeFileSync(join(brain, 'code', 'imessage', 'lib', 'db.cjs'), 'module.exports = { listChats: () => [], findExistingChat: () => null }\n')
  const mail = node([join(res, 'desk', 'gmail-send.cjs'), 'from', brain])
  check('the packed mail helper loads and stops at no-token', mail.status === 2 && mail.stdout.trim() === 'no-token', `${mail.status} ${mail.stdout} ${mail.stderr}`)
  const text = node([join(res, 'desk', 'imessage.cjs'), 'lookup', brain, 'Nobody Here'])
  check('the packed text helper loads a brain file and answers lookup', text.status === 0 && text.stdout.trim() === JSON.stringify({ sendable: false, note: 'No existing iMessage thread for Nobody Here.' }), `${text.status} ${text.stdout} ${text.stderr}`)
}

log(failed ? 'ELECTRON_44_FAIL' : packed ? 'ELECTRON_44_PACKED_PASS' : 'ELECTRON_44_PASS')
process.exit(failed ? 1 : 0)
