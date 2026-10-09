// Runs under Electron (see scripts/check-whatsapp-send.ts). WhatsApp sending from a chat (the whatsapp_send tool and
// its Send card) and from Desk (a WhatsApp text tile), through the real browser, against a stand-in WhatsApp.
import './set-paths.ts'
import { app, BaseWindow, session, type Session, type WebContents, type WebContentsView } from 'electron'
import { spawn } from 'node:child_process'
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BROWSER_RULE } from '../../src/shared/chat-reach.ts'
import type { DeskCli, WhatsAppSendAnswer, WhatsAppSendAsk } from '../../src/shared/desk.ts'
import { sharedDeskBrowser } from '../../src/main/shared-browser.ts'
import { answerSend, bridgeScriptPath, browserServer, startBrowserBridge, stopBrowserBridge } from '../../src/main/browser-bridge.ts'
import { createDeskController } from '../../src/main/desk/controller.ts'
import { parseFences } from '../../src/main/desk/fences.ts'
import { createSenders } from '../../src/main/desk/senders.ts'
import { seedDesk } from '../../src/main/desk/seed.ts'
import { standIn } from './wa-stand-in.ts'

const ROOT = process.env.BB_ROOT || process.cwd()
const TRACE = join(ROOT, 'plans', '20261009-whatsapp-send-check.txt')
writeFileSync(TRACE, `whatsapp send check ${new Date().toISOString()}\n`)
const log = (line: string) => {
  console.log(line)
  appendFileSync(TRACE, line + '\n')
}
class Fail extends Error {}
function check(name: string, ok: boolean, detail = '') {
  log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  (${detail.replace(/\s+/g, ' ').slice(0, 260)})` : ''}`)
  if (!ok) throw new Fail(name)
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
function deadline<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let t: NodeJS.Timeout | undefined
  return Promise.race([work, new Promise<never>((_, no) => (t = setTimeout(() => no(new Fail(`${what} passed ${ms / 1000} s`)), ms)))]).finally(() => clearTimeout(t))
}

app.on('session-created', (ses: Session) => {
  ses.protocol.handle('https', (req) => {
    const u = new URL(req.url)
    if (u.hostname !== 'web.whatsapp.com') return fetch(req)
    return new Response(standIn(u), { headers: { 'content-type': 'text/html' } })
  })
})

type Mcp = { call: (method: string, params?: unknown) => Promise<any>; kill: () => void }
async function mcpFor(owner: string): Promise<Mcp> {
  const spec = browserServer(owner)
  if (!spec) throw new Fail('bridge not running')
  const child = spawn(spec.command, spec.args, { env: { ...process.env, ...spec.env }, stdio: ['pipe', 'pipe', 'inherit'] })
  let buf = ''
  let id = 0
  const waiting = new Map<number, (m: any) => void>()
  child.stdout!.on('data', (d) => {
    buf += d
    let n
    while ((n = buf.indexOf('\n')) >= 0) {
      const m = JSON.parse(buf.slice(0, n))
      buf = buf.slice(n + 1)
      waiting.get(m.id)?.(m)
      waiting.delete(m.id)
    }
  })
  const mcp: Mcp = {
    call: (method, params) =>
      new Promise((done) => {
        const i = ++id
        waiting.set(i, done)
        child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n')
      }),
    kill: () => child.kill()
  }
  await mcp.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'check', version: '1' } })
  return mcp
}
async function tool(mcp: Mcp, name: string, args: Record<string, unknown> = {}, ms = 60_000) {
  const m = await deadline(mcp.call('tools/call', { name, arguments: args }), ms, name)
  const content = (m?.result?.content || []) as { type: string; text?: string }[]
  return { text: content.filter((c) => c.type === 'text').map((c) => c.text).join('\n'), isError: !!m?.result?.isError }
}

const WA = 'https://web.whatsapp.com/'
const MAIN = 'persist:brain-browser'
const INDIA = 'persist:brain-wa-india'
const WORK = 'persist:brain-wa-work'
function views(): WebContents[] {
  return BaseWindow.getAllWindows()
    .flatMap((w) => (w.isDestroyed() ? [] : (w.contentView.children as WebContentsView[])))
    .map((v) => v.webContents)
    .filter((wc) => wc && !wc.isDestroyed())
}
const waIn = (partition: string) =>
  views().find((wc) => wc.session === session.fromPartition(partition) && wc.getURL().startsWith('https://web.whatsapp.com'))
type Sent = { chat: string; text: string }
async function sentIn(partition: string): Promise<Sent[]> {
  const wc = waIn(partition)
  return wc ? (JSON.parse((await wc.executeJavaScript('localStorage.sent || "[]"')) as string) as Sent[]) : []
}
const to = (all: Sent[], chat: string) => all.filter((s) => s.chat === chat)

const asks: WhatsAppSendAsk[] = []
async function ask(mcp: Mcp, args: Record<string, unknown>): Promise<WhatsAppSendAsk> {
  const before = asks.length
  const r = await tool(mcp, 'whatsapp_send', args)
  check(`whatsapp_send to ${String(args.to)} puts up a card`, !r.isError && /Nothing is sent until the person presses Send/.test(r.text) && asks.length === before + 1, r.text)
  return asks[asks.length - 1]
}
/** One card answered yes through the same function the IPC handler calls. */
async function send(mcp: Mcp, args: Record<string, unknown>, ms = 45_000): Promise<WhatsAppSendAnswer> {
  const a = await ask(mcp, args)
  return deadline(answerSend(a.id, true, a.owner), ms, `send to ${String(args.to)}`)
}
const notSent = (r: WhatsAppSendAnswer, note: RegExp) => 'ok' in r && !r.ok && note.test(r.note)

async function phase() {
  await startBrowserBridge({
    dir: app.getPath('userData'),
    script: bridgeScriptPath({ appPath: ROOT }),
    exec: process.execPath,
    browser: sharedDeskBrowser(),
    onOpened: () => {},
    onSendAsk: (a) => asks.push(a)
  })
  const A = await mcpFor('chat:A')
  const B = await mcpFor('chat:B')

  const listed = await A.call('tools/list')
  const wsend = ((listed?.result?.tools || []) as { name: string; description: string; inputSchema: { properties: Record<string, unknown> } }[]).find((t) => t.name === 'whatsapp_send')
  check('1 whatsapp_send has to, text and account', !!wsend && ['to', 'text', 'account'].every((k) => k in (wsend.inputSchema.properties || {})))
  check('1 its description says nothing is sent until the person presses Send', /Nothing is sent until the person presses Send/.test(wsend?.description || ''), wsend?.description)
  check('1 BROWSER_RULE says to draft and call whatsapp_send', /draft it and call whatsapp_send/.test(BROWSER_RULE), BROWSER_RULE)

  await tool(A, 'browser_open', { url: `${WA}?link=1` })
  await tool(A, 'browser_open', { url: `${WA}?link=1`, account: 'india' })
  check('0 main and india are linked stand-ins', !!waIn(MAIN) && !!waIn(INDIA))

  const a2 = await ask(A, { to: 'Raj', text: 'Hello Raj\nSecond line', account: 'india' })
  check('2 the card names chat A, india, Raj and the text', a2.owner === 'chat:A' && a2.account === 'india' && a2.to === 'Raj' && a2.text === 'Hello Raj\nSecond line', JSON.stringify(a2))
  check('2 nothing is sent before the answer (F1)', (await sentIn(MAIN)).length === 0 && (await sentIn(INDIA)).length === 0)

  const both = await deadline(Promise.all([answerSend(a2.id, true, 'chat:A'), answerSend(a2.id, true, 'chat:A')]), 45_000, 'two answers')
  const okOnes = both.filter((r) => 'ok' in r && r.ok)
  const refusedOnes = both.filter((r) => 'refused' in r)
  check('3 two answers at once start one send', okOnes.length === 1 && refusedOnes.length === 1 && (okOnes[0] as { chat: string }).chat === 'Raj Patel', JSON.stringify(both))
  check('3 india got one message with both lines and no old draft (F4, F10)', JSON.stringify(await sentIn(INDIA)) === JSON.stringify([{ chat: 'Raj Patel', text: 'Hello Raj\nSecond line' }]), JSON.stringify(await sentIn(INDIA)))
  check('3 main got nothing (F3)', (await sentIn(MAIN)).length === 0)

  const later = [await answerSend(a2.id, true, 'chat:A'), await answerSend(a2.id, false, 'chat:A'), await answerSend('no-such-card', true, 'chat:A')]
  const a4 = await ask(A, { to: 'Raj', text: 'Not from B', account: 'india' })
  const fromB = await answerSend(a4.id, true, 'chat:B')
  check('4 a later answer, an unknown id, and another chat answering are refused (F9)', later.every((r) => 'refused' in r) && 'refused' in fromB && (await sentIn(INDIA)).length === 1, JSON.stringify([...later, fromB]))

  const no = await answerSend(a4.id, false, 'chat:A')
  const yesAfterNo = await answerSend(a4.id, true, 'chat:A')
  check('5 Don\'t send sends nothing, and a yes after it is refused (F8)', 'ok' in no && !no.ok && 'refused' in yesAfterNo && (await sentIn(INDIA)).length === 1, JSON.stringify([no, yesAfterNo]))

  let before = await sentIn(INDIA)
  const sam = await send(A, { to: 'Sam', text: 'Hi Sam', account: 'india' })
  check('6 Sam matches two chats: not sent, both named', notSent(sam, /Sam Lee/) && notSent(sam, /Sam Ortiz/) && (await sentIn(INDIA)).length === before.length, JSON.stringify(sam))
  const nobody = await send(A, { to: 'Nobody', text: 'Hi', account: 'india' })
  check('6 Nobody: not sent', notSent(nobody, /^No WhatsApp chat named Nobody\.$/) && (await sentIn(INDIA)).length === before.length, JSON.stringify(nobody))
  const lee = await send(A, { to: 'sam lee', text: 'Hi Sam Lee', account: 'india' })
  const afterLee = await sentIn(INDIA)
  check('6 sam lee goes to Sam Lee only', 'ok' in lee && lee.ok && afterLee.length === before.length + 1 && afterLee.at(-1)?.chat === 'Sam Lee', JSON.stringify(lee))
  await tool(A, 'browser_open', { url: WA, account: 'india' })
  const searched = await tool(A, 'browser_type', { target: 'Search or start a new chat', text: 'Pat' })
  const india = waIn(INDIA)!
  const rows = (await india.executeJavaScript('Array.from(document.querySelectorAll("#pane-side [role=row] span[title]")).map((s) => s.getAttribute("title"))')) as string[]
  check('6 a search for Pat lists Raj Patel above Pat', rows.indexOf('Raj Patel') >= 0 && rows.indexOf('Raj Patel') < rows.indexOf('Pat'), `${rows.join(',')} | ${searched.text.slice(0, 60)}`)
  before = await sentIn(INDIA)
  const pat = await send(A, { to: 'Pat', text: 'Hi Pat', account: 'india' })
  const afterPat = await sentIn(INDIA)
  check('6 Pat goes to Pat only, not Raj Patel (F2)', 'ok' in pat && pat.ok && afterPat.length === before.length + 1 && afterPat.at(-1)?.chat === 'Pat' && to(afterPat, 'Raj Patel').length === to(before, 'Raj Patel').length, JSON.stringify(afterPat.slice(-2)))
  const decoy = await send(A, { to: 'Decoy', text: 'Hi Decoy', account: 'india' })
  check('6 Decoy opens Someone Else: not sent (the header check)', notSent(decoy, /Someone Else/) && (await sentIn(INDIA)).length === afterPat.length, JSON.stringify(decoy))

  const t7 = Date.now()
  const work = await send(A, { to: 'Raj', text: 'From work', account: 'work' }, 35_000)
  check('7 an account that is not linked: not sent, said so (F7)', notSent(work, /not linked/) && Date.now() - t7 < 35_000 && (await sentIn(WORK)).length === 0, JSON.stringify(work))
  const askCount = asks.length
  const mainBefore = (await sentIn(MAIN)).length
  const indiaBefore = (await sentIn(INDIA)).length
  const bad = await tool(A, 'whatsapp_send', { to: 'Raj', text: 'x', account: '../x' })
  check('7 account ../x is an error with no card', bad.isError && asks.length === askCount && (await sentIn(MAIN)).length === mainBefore && (await sentIn(INDIA)).length === indiaBefore, bad.text)
  const m1 = await send(A, { to: 'Raj', text: 'Main without account' })
  const m2 = await send(A, { to: 'Raj', text: 'Main by name', account: 'main' })
  const mainAfter = await sentIn(MAIN)
  check('7 no account and main both send from main only (F3)', 'ok' in m1 && m1.ok && 'ok' in m2 && m2.ok && mainAfter.length === mainBefore + 2 && (await sentIn(INDIA)).length === indiaBefore, JSON.stringify(mainAfter))

  const slow = await send(A, { to: 'Slowpoke', text: 'Slow one', account: 'india' })
  check('8 Slowpoke stays pending: not sent, posted once (F5)', notSent(slow, /did not show it as sent/) && to(await sentIn(INDIA), 'Slowpoke').length === 1, JSON.stringify(slow))
  const echo = await send(A, { to: 'Echo', text: 'Echo test', account: 'india' })
  check('8 Echo\'s older Sent row does not count: not sent, one new post', notSent(echo, /did not show it as sent/) && to(await sentIn(INDIA), 'Echo').length === 1, JSON.stringify(echo))
  const ghost = await send(A, { to: 'Ghost', text: 'Boo', account: 'india' })
  check('8 Ghost adds no row: not sent, nothing posted', notSent(ghost, /did not show it as sent/) && to(await sentIn(INDIA), 'Ghost').length === 0, JSON.stringify(ghost))
  const reader = await send(A, { to: 'Reader', text: 'Read me', account: 'india' })
  check('8 Reader goes to Read, never Sent: sent', 'ok' in reader && reader.ok && to(await sentIn(INDIA), 'Reader').length === 1, JSON.stringify(reader))
  const fancyText = '*Reminder* 🙏 call at 5'
  const fancy = await send(A, { to: 'Fancy', text: fancyText, account: 'india' })
  const drawn = (await waIn(INDIA)!.executeJavaScript('document.querySelector("#main .msgs [role=row]:last-child .text").innerHTML')) as string
  check('8b a message WhatsApp draws without its *marks* and with the emoji as an image is reported sent, once (review 2)', 'ok' in fancy && fancy.ok && JSON.stringify(to(await sentIn(INDIA), 'Fancy')) === JSON.stringify([{ chat: 'Fancy', text: fancyText }]) && /<b>Reminder<\/b>/.test(drawn) && /<img alt="🙏"/.test(drawn), `${JSON.stringify(fancy)} ${drawn}`)

  await tool(B, 'browser_open', { url: WA, account: 'india' })
  await tool(B, 'browser_type', { target: 'Search or start a new chat', text: 'Raj' })
  await tool(B, 'browser_key', { key: 'Enter' })
  const bRead = await tool(B, 'browser_read')
  check('9 chat B has Raj open with the message box on its list', /field Type a message/.test(bRead.text), bRead.text.slice(0, 200))
  const a9 = await ask(A, { to: 'Raj Patel', text: 'Lane check', account: 'india' })
  let sendDone = 0
  const sending = answerSend(a9.id, true, 'chat:A').then((r) => {
    sendDone = Date.now()
    return r
  })
  await sleep(100)
  const typing = tool(B, 'browser_type', { target: 'Type a message', text: 'intruder' }).then((r) => ({ r, at: Date.now() }))
  const [r9, typed] = await deadline(Promise.all([sending, typing]), 60_000, 'lane')
  const raj = to(await sentIn(INDIA), 'Raj Patel')
  check('9 a browser step on the window waits for the send (F6)', 'ok' in r9 && r9.ok && typed.at >= sendDone && raj.at(-1)?.text === 'Lane check', `${JSON.stringify(r9)} send ${sendDone} type ${typed.at} ${JSON.stringify(raj.at(-1))}`)

  const s10 = (await sentIn(INDIA)).length
  await tool(A, 'browser_open', { url: WA, account: 'india' })
  await tool(A, 'browser_type', { target: 'Search or start a new chat', text: 'Sam' })
  const searchEnter = await tool(A, 'browser_key', { key: 'Enter' })
  check('10 Enter in the search box is not refused', !searchEnter.isError && /Sam Lee/.test(searchEnter.text), searchEnter.text.slice(0, 120))
  await tool(A, 'browser_type', { target: 'Type a message', text: 'x' })
  const enter = await tool(A, 'browser_key', { key: 'Enter' })
  const ret = await tool(A, 'browser_key', { key: 'return' })
  const click = await tool(A, 'browser_click', { target: 'Send' })
  check('10 Enter and return in the message box are refused and name whatsapp_send (F1)', enter.isError && ret.isError && /whatsapp_send/.test(enter.text) && /whatsapp_send/.test(ret.text), `${enter.text} | ${ret.text}`)
  check('10 the Send button is refused too, and nothing went', click.isError && (await sentIn(INDIA)).length === s10, click.text)

  const sticky = await send(A, { to: 'Sticky', text: 'Hello sticky', account: 'india' })
  const box = (await waIn(INDIA)!.executeJavaScript('document.querySelector("footer [contenteditable]").innerText')) as string
  check('11 a box that will not take the text: not sent, nothing posted, box empty (F10)', notSent(sticky, /did not take the text/) && to(await sentIn(INDIA), 'Sticky').length === 0 && box.trim() === '', `${JSON.stringify(sticky)} box "${box}"`)

  const brain = mkdtempSync(join(tmpdir(), 'wa-desk-'))
  try {
    const turn = ['Here is the note for Raj.', '```sms', 'to: Raj Patel', 'via: whatsapp', 'account: india', '', 'The September note is ready.', '```'].join('\n')
    const parsed = parseFences(turn, { from: 'drafts', bots: [] })
    check('12 the sms block carries account india', parsed.sms?.via === 'WhatsApp' && parsed.sms?.account === 'india', JSON.stringify(parsed.sms))
    const detect = (): Record<DeskCli, boolean> => ({ grok: true, claude: false, gpt: false, cursor: false })
    seedDesk({ brain, role: 'owner', detect })
    const queue: string[] = []
    const runner = {
      run: async (o: { bot: { cli: DeskCli; model: string } }) => ({ status: 'ok' as const, text: queue.shift() ?? 'Noted.', lastTry: { cli: o.bot.cli, model: o.bot.model }, tries: [] }),
      stop: () => false,
      stopAll: () => [],
      keepWaiting: () => false
    }
    const desk = createDeskController({ brain, role: 'owner', runner, browser: sharedDeskBrowser(), senders: createSenders({ dryRun: false }), detect, tokenReady: () => true })
    const tiles = () => desk.store.readMail().filter((m) => m.kind === 'text')
    const deskBefore = await sentIn(INDIA)
    queue.push(turn)
    await desk.say('Text Raj on India.', 'drafts')
    const tile = tiles().at(-1)
    check('12 the tile is a sendable WhatsApp tile on india', tile?.textMsg?.via === 'WhatsApp' && tile.textMsg.account === 'india' && tile.textMsg.sendable === true, JSON.stringify(tile?.textMsg))
    await deadline(desk.answerText(tile!.id, 'yes'), 60_000, 'desk send')
    const deskAfter = await sentIn(INDIA)
    const stamped = desk.store.readMail().find((m) => m.replaces === tile!.id)
    check('12 Send on the tile posts the body once to Raj Patel and the tile ends sent', deskAfter.length === deskBefore.length + 1 && deskAfter.at(-1)?.chat === 'Raj Patel' && deskAfter.at(-1)?.text === 'The September note is ready.' && stamped?.textMsg?.sent === 'yes', `${JSON.stringify(deskAfter.at(-1))} ${JSON.stringify(stamped?.textMsg)}`)
    queue.push(turn.replace('The September note is ready.', 'Twice pressed.'))
    await desk.say('Once more.', 'drafts')
    const twice = tiles().at(-1)
    const beforeTwice = (await sentIn(INDIA)).length
    await deadline(Promise.all([desk.answerText(twice!.id, 'yes'), desk.answerText(twice!.id, 'yes')]), 60_000, 'desk double send')
    const afterTwice = await sentIn(INDIA)
    check('12 two Send answers at once on one tile post once (review 1)', afterTwice.length === beforeTwice + 1 && to(afterTwice, 'Raj Patel').filter((s) => s.text === 'Twice pressed.').length === 1, JSON.stringify(afterTwice.slice(-2)))
    queue.push(turn.replace('The September note is ready.', 'Second draft.'))
    await desk.say('Another one.', 'drafts')
    const second = tiles().at(-1)
    await desk.answerText(second!.id, 'no')
    const noStamp = desk.store.readMail().find((m) => m.replaces === second!.id)
    check('12 Not now sends nothing and the tile ends not sent', (await sentIn(INDIA)).length === afterTwice.length && noStamp?.textMsg?.sent === 'no', JSON.stringify(noStamp?.textMsg))
    queue.push(turn.replace('account: india', 'account: ../x'))
    await desk.say('Bad account.', 'drafts')
    const badTile = tiles().at(-1)
    await desk.answerText(badTile!.id, 'yes')
    check('12 a bad account tile is not sendable, has a note, and Send posts nothing (F8, F3)', badTile?.textMsg?.sendable === false && !!badTile.textMsg.note && (await sentIn(INDIA)).length === afterTwice.length && (await sentIn(MAIN)).length === mainAfter.length, JSON.stringify(badTile?.textMsg))
  } finally {
    rmSync(brain, { recursive: true, force: true })
  }

  A.kill()
  B.kill()
  stopBrowserBridge()
  log('WHATSAPP_SEND_PASS')
}

app.whenReady().then(async () => {
  try {
    await phase()
    app.quit()
  } catch (e) {
    log(`WHATSAPP_SEND_FAIL ${e instanceof Fail ? e.message : String((e as Error)?.stack || e)}`)
    app.exit(1)
  }
})
app.on('window-all-closed', () => {})
