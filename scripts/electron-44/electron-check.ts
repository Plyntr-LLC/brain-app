// Runs under Electron 44 (see scripts/check-electron-44.ts): the clipboard through the real setup paths, and node-pty.
import '../in-app-browser/set-paths.ts'
import { app, BrowserWindow, clipboard, ipcMain } from 'electron'
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TRACE = process.env.BB_TRACE || join(process.cwd(), 'plans', '20261009-electron-44-check.txt')
const log = (line: string) => {
  console.log(line)
  appendFileSync(TRACE, line + '\n')
}
class Fail extends Error {}
function check(name: string, ok: boolean, detail = '') {
  log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  (${detail.replace(/\s+/g, ' ').slice(0, 200)})` : ''}`)
  if (!ok) throw new Fail(name)
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const ORG_URL = 'https://github.com/orgs/acme-test-org/'

// Record every handler the real ipc-stubs registers, so the check calls the same function the renderer would.
const handlers = new Map<string, (...args: unknown[]) => unknown>()
const handle = ipcMain.handle.bind(ipcMain)
ipcMain.handle = ((channel: string, fn: (...args: unknown[]) => unknown) => {
  handlers.set(channel, fn)
  return handle(channel, fn as never)
}) as typeof ipcMain.handle

app.whenReady().then(async () => {
  const saved = await clipboard.readText()
  try {
    check('electron is 44.7.0', process.versions.electron === '44.7.0', process.versions.electron)
    const { registerStubIpc } = await import('../../src/main/ipc-stubs.ts')
    registerStubIpc()
    await clipboard.writeText(ORG_URL)
    const got = await handlers.get('setup:clipOrg')!({})
    check('setup:clipOrg answers the copied org, not a pending Promise', JSON.stringify(got) === JSON.stringify({ ok: true, org: 'acme-test-org' }), JSON.stringify(got))

    const preload = join(mkdtempSync(join(tmpdir(), 'e44-preload-')), 'preload.cjs')
    writeFileSync(preload, "const { ipcRenderer } = require('electron')\nipcRenderer.on('setup:back', (_e, p) => ipcRenderer.send('probe:back', p))\n")
    const win = new BrowserWindow({ show: false, webPreferences: { preload, sandbox: false, contextIsolation: true } })
    await win.loadURL('about:blank')
    const back = new Promise<unknown>((resolve) => ipcMain.once('probe:back', (_e, p) => resolve(p)))
    const { notifySetupBack, watchClipboardOrg } = await import('../../src/main/bring-front.ts')
    await notifySetupBack()
    const delivered = await Promise.race([back, sleep(3000).then(() => 'timeout')])
    check('notifySetupBack delivers the copied org on setup:back', JSON.stringify(delivered) === JSON.stringify({ org: 'acme-test-org' }), JSON.stringify(delivered))

    await clipboard.writeText('not an org link at all, just words')
    const watching = watchClipboardOrg(5000)
    setTimeout(() => void clipboard.writeText(ORG_URL), 900)
    const watched = await watching
    check('watchClipboardOrg returns the org copied while it waits', watched === 'acme-test-org', watched)
    win.destroy()

    const pty = (await import('node-pty')) as typeof import('node-pty')
    const term = pty.spawn('/bin/echo', ['pty-ok'], { cols: 80, rows: 10 })
    let out = ''
    term.onData((d) => (out += d))
    const code = await new Promise<number>((resolve) => term.onExit((e) => resolve(e.exitCode)))
    check('node-pty spawns under Electron 44 and reads the child back', code === 0 && out.includes('pty-ok'), JSON.stringify(out))
    log('ELECTRON_44_DEV_PASS')
    await clipboard.writeText(saved)
    app.exit(0)
  } catch (e) {
    log(`ELECTRON_44_FAIL ${e instanceof Fail ? e.message : String((e as Error)?.stack || e)}`)
    await clipboard.writeText(saved)
    app.exit(1)
  }
})
app.on('window-all-closed', () => {})
