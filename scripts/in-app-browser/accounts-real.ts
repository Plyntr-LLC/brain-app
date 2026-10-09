// Real web.whatsapp.com in two accounts on a temp userData: both must reach the QR sign-in, each in its own store.
// Bundled and run by scripts/check-whatsapp-accounts.ts --real.
import './set-paths.ts'
import { app, BaseWindow, type WebContents, type WebContentsView } from 'electron'
import { appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { faceShared, sharedDeskBrowser } from '../../src/main/shared-browser.ts'

const ROOT = process.env.BB_ROOT || process.cwd()
const TRACE = join(ROOT, 'plans', '20261009-whatsapp-accounts-real.txt')
const SHOTS = join(ROOT, 'plans', '20261009-whatsapp-accounts-shots')
writeFileSync(TRACE, `real whatsapp accounts ${new Date().toISOString()}\n`)
const log = (line: string) => {
  console.log(line)
  appendFileSync(TRACE, line + '\n')
}
const views = (): WebContents[] =>
  BaseWindow.getAllWindows()
    .flatMap((w) => (w.isDestroyed() ? [] : (w.contentView.children as WebContentsView[])))
    .map((v) => v.webContents)
    .filter((wc) => wc && !wc.isDestroyed())

app.whenReady().then(async () => {
  let ok = true
  const b = sharedDeskBrowser()
  for (const account of ['', 'india']) {
    const id = `real-${account || 'main'}`
    await b.open(id, 'chat:real')
    const r = await b.runStep(id, { action: 'url', url: 'https://web.whatsapp.com/', account })
    b.release(id)
    let face = await faceShared('chat:real')
    for (let i = 0; i < 20 && !face.signIn; i++) {
      await new Promise((d) => setTimeout(d, 1000))
      face = await faceShared('chat:real')
    }
    const wc = views().find((v) => v.getURL().startsWith('https://web.whatsapp.com') && v.session.storagePath?.endsWith(account ? 'brain-wa-india' : 'brain-browser'))
    const text = wc ? ((await wc.executeJavaScript('document.body.innerText')) as string) : ''
    const unsupported = /update (google )?chrome|browser.*not supported|unsupported/i.test(text)
    const pass = face.signIn && !!wc && !unsupported
    ok &&= pass
    log(`${pass ? 'ok  ' : 'FAIL'} ${account || 'main'}: signIn ${face.signIn} storagePath ${wc?.session.storagePath} first result ${'signIn' in r ? 'sign-in' : Object.keys(r).join(',')} text ${text.replace(/\s+/g, ' ').slice(0, 90)}`)
    if (face.src) writeFileSync(join(SHOTS, `${account || 'main'}.jpg`), Buffer.from(face.src, 'base64'))
  }
  const paths = new Set(views().filter((v) => v.getURL().startsWith('https://web.whatsapp.com')).map((v) => v.session.storagePath))
  ok &&= paths.size === 2
  log(`${paths.size === 2 ? 'ok  ' : 'FAIL'} two WhatsApp windows on two stores: ${[...paths].join(' | ')}`)
  log(ok ? 'WHATSAPP_REAL_PASS' : 'WHATSAPP_REAL_FAIL')
  app.exit(ok ? 0 : 1)
})
app.on('window-all-closed', () => {})
