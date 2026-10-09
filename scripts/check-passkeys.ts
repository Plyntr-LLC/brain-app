// After a Developer ID `npm run pack:mac`: the signing that Touch ID passkeys need, checked without launching
// anything. The live part (a page in the packed app sees Touch ID) is a step in scripts/check-live-app.ts.
// node --experimental-strip-types scripts/check-passkeys.ts [--notarized]   Prints PASSKEYS_PACKED_PASS.
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const { verifyApp } = require('./verify-profile.cjs') as { verifyApp: (app: string) => { expires: string } }
const app = join(root, 'dist', 'mac-arm64', 'Brain.app')
const main = join(app, 'Contents', 'MacOS', 'Brain')
let failed = false
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  (${detail.replace(/\s+/g, ' ').slice(0, 300)})` : ''}`)
  if (!ok) failed = true
}

let profile = ''
try {
  profile = verifyApp(app).expires
} catch (e) {
  profile = `error: ${(e as Error).message}`
}
check('the embedded profile names Brain and lists the signing certificate', !profile.startsWith('error'), profile)

// Every executable file that is Mach-O, not only the helper apps.
const files = execFileSync('find', [app, '-type', 'f', '-perm', '+111'], { encoding: 'utf8' }).split('\n').filter(Boolean)
const machO = files.filter((f) => /Mach-O/.test(spawnSync('file', ['-b', f], { encoding: 'utf8' }).stdout))
const carrying = machO.filter((f) => /keychain-access-groups|com\.apple\.application-identifier/.test(spawnSync('codesign', ['-d', '--entitlements', '-', '--xml', f], { encoding: 'utf8' }).stdout))
check(`the keychain and app-identity entitlements are on Brain's main executable only (${machO.length} Mach-O files)`, carrying.length === 1 && carrying[0] === main, carrying.map((f) => relative(app, f)).join(', '))
const mainEnt = spawnSync('codesign', ['-d', '--entitlements', '-', '--xml', main], { encoding: 'utf8' }).stdout
check('the main executable carries the passkey group, the camera and the microphone', mainEnt.includes('DWYL4KK53B.com.plyntr.brain.webauthn') && mainEnt.includes('com.apple.security.device.camera') && mainEnt.includes('com.apple.security.device.audio-input'))

check('codesign --verify --deep --strict passes', spawnSync('codesign', ['--verify', '--deep', '--strict', app]).status === 0)
const installed = '/Applications/Brain.app'
if (existsSync(installed)) {
  const dr = (spawnSync('codesign', ['-d', '-r-', installed], { encoding: 'utf8' }).stdout + spawnSync('codesign', ['-d', '-r-', installed], { encoding: 'utf8' }).stderr).match(/designated => (.*)/)?.[1] || ''
  check("the new build satisfies the installed Brain's designated requirement (the update is accepted)", !!dr && spawnSync('codesign', ['--verify', '--deep', '--strict', `-R=${dr}`, app]).status === 0, dr)
}
const plist = readFileSync(join(app, 'Contents', 'Info.plist'), 'utf8')
check('Info.plist has the camera and microphone texts and no location text', /NSCameraUsageDescription/.test(plist) && /NSMicrophoneUsageDescription/.test(plist) && !/NSLocation/.test(plist))
check('the page guard is in Resources', existsSync(join(app, 'Contents', 'Resources', 'page-guard.cjs')))
if (process.argv.includes('--notarized')) {
  const assess = spawnSync('spctl', ['-a', '-vvv', '-t', 'exec', app], { encoding: 'utf8' })
  check('Gatekeeper accepts the notarized app', assess.status === 0, assess.stderr)
}
console.log(failed ? 'PASSKEYS_PACKED_FAIL' : 'PASSKEYS_PACKED_PASS')
process.exitCode = failed ? 1 : 0
