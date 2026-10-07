import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { BROWSE_MAX_CONTROLS, BROWSE_TEXT_CHARS, payCheck } from '../../shared/desk.ts'
import type { DeskLaunch } from '../../shared/desk.ts'
import { createDeskBrowser } from './browser.ts'
import { deskProfileDir, pageSnapshot } from './chrome.ts'
import type { DeskPage } from './chrome.ts'

const HOME = 'https://summit.example/'
const PRICING = 'https://summit.example/pricing'
const CART = 'https://summit.example/cart'
const LOGIN = 'https://summit.example/login'
const SIGN_IN = 'https://summit.example/signin'
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

/** About 18,000 characters, so the 8,000 cut and the scroll both show. */
const LONG = Array.from({ length: 400 }, (_, i) => `Line ${String(i + 1).padStart(3, '0')} of the Summit page, plain words.`).join('\n')

type Fixture = {
  title: string
  text: string
  controls: string[]
  hasPassword?: boolean
  /** control number -> where clicking it lands */
  go?: Record<number, string>
  /** field number -> its form's submit control */
  submit?: Record<number, { index: number; name: string } | null>
}

const SITE: Record<string, Fixture> = {
  [HOME]: {
    title: 'Summit',
    text: LONG,
    controls: ['link Pricing', 'link About', 'field Search', 'button Search', 'link Log', 'link Log', 'link payment'],
    go: { 0: PRICING, 6: PRICING },
    submit: { 2: { index: 3, name: 'Search' } }
  },
  [PRICING]: {
    title: 'Pricing',
    text: 'Plans start at $40.',
    controls: [
      'button Pay now',
      'button Place order',
      'button Complete purchase',
      'button Send message',
      'button Post',
      'button Submit',
      'button Save',
      'button Apply',
      'link Home'
    ],
    go: { 0: CART, 1: CART, 8: HOME }
  },
  [CART]: {
    title: 'Cart',
    text: 'One item.',
    controls: ['field Promo code', 'button Place order', 'field Note', 'link Login'],
    go: { 3: LOGIN },
    submit: { 0: { index: 1, name: 'Place order' }, 2: null }
  },
  [LOGIN]: { title: 'Summit', text: 'Email and password, please.', controls: ['field Email', 'field Password', 'button Continue'], hasPassword: true },
  [SIGN_IN]: { title: 'Sign in to Summit', text: 'Use your account.', controls: ['button Next'] }
}

const tick = () => new Promise((r) => setImmediate(r))

/** A fake desk window over the fixture site. Its snapshot runs the real evaluate body on a fake document. */
function fakeWindow() {
  const calls = {
    launch: [] as { chromePath: string; profileDir: string }[],
    goto: [] as string[],
    click: [] as number[],
    type: [] as [number, string][],
    submit: [] as number[],
    submitFor: [] as number[],
    scroll: [] as string[],
    front: 0
  }
  let url = 'about:blank'
  let scrollY = 0
  let closed = false
  const page = (): Fixture => SITE[url] ?? { title: '', text: '', controls: [] }
  const adapter: DeskPage = {
    goto: async (u) => {
      calls.goto.push(u)
      url = u
      scrollY = 0
    },
    snapshot: async () => {
      const f = page()
      const doc = { title: f.title, bodyText: f.text, controls: f.controls, hasPassword: !!f.hasPassword, scrollY }
      return { url, ...pageSnapshot(doc, BROWSE_TEXT_CHARS, BROWSE_MAX_CONTROLS) }
    },
    click: async (i) => {
      calls.click.push(i)
      const to = page().go?.[i]
      if (to) {
        url = to
        scrollY = 0
      }
    },
    type: async (i, text) => {
      calls.type.push([i, text])
    },
    submit: async (i) => {
      calls.submit.push(i)
    },
    submitFor: async (i) => {
      calls.submitFor.push(i)
      return page().submit?.[i] ?? null
    },
    scroll: async (dir) => {
      calls.scroll.push(dir)
      scrollY = Math.max(0, scrollY + (dir === 'down' ? 6000 : -6000))
    },
    front: async () => {
      calls.front++
    },
    closed: () => closed
  }
  const launch: DeskLaunch = async (opts) => {
    calls.launch.push(opts)
    closed = false
    return adapter
  }
  return { calls, launch, adapter, navigate: (u: string) => (url = u), closeWindow: () => (closed = true) }
}

function deskBrowser(launch: DeskLaunch) {
  return createDeskBrowser({ launch, chromePath: CHROME, profileDir: deskProfileDir() })
}

/** An open session on `start`, plus the fake window behind it. */
async function onPage(start = HOME, id = 'b_1') {
  const w = fakeWindow()
  const b = deskBrowser(w.launch)
  await b.open(id)
  const first = await b.runStep(id, { action: 'url', url: start })
  return { w, b, id, first }
}

test('open takes the lock and does not navigate; the url step calls goto and returns the first 8,000 characters and the controls', async () => {
  const w = fakeWindow()
  const b = deskBrowser(w.launch)
  assert.equal(b.windowOpen(), false)
  assert.equal(await b.open('b_1'), undefined)
  assert.equal(b.windowOpen(), true)
  assert.deepEqual(w.calls.goto, [])

  const r = await b.runStep('b_1', { action: 'url', url: HOME })
  assert.deepEqual(w.calls.goto, [HOME])
  assert.ok('ok' in r)
  assert.equal(r.url, HOME)
  assert.equal(r.title, 'Summit')
  assert.ok(r.text.length <= BROWSE_TEXT_CHARS && r.text.length > BROWSE_TEXT_CHARS - 80)
  assert.equal(r.text, LONG.slice(0, r.text.length))
  assert.equal(LONG[r.text.length], '\n', 'cut on a line break')
  assert.deepEqual(r.controls, SITE[HOME].controls)
})

test('open uses the desk profile, not the everyday Chrome profile, and launches Chrome once', async () => {
  const w = fakeWindow()
  const b = deskBrowser(w.launch)
  await b.open('b_1')
  b.release('b_1')
  await b.open('b_2')
  assert.deepEqual(w.calls.launch, [{ chromePath: CHROME, profileDir: join(homedir(), '.brain-sessions', 'desk') }])
  assert.notEqual(w.calls.launch[0].profileDir, join(homedir(), 'Library', 'Application Support', 'Google', 'Chrome'))
})

test('click by name and click #1 each land on the next fixture page', async () => {
  const byName = await onPage()
  const r = await byName.b.runStep(byName.id, { action: 'click', detail: 'Pricing' })
  assert.deepEqual(byName.w.calls.click, [0])
  assert.ok('ok' in r)
  assert.equal(r.url, PRICING)
  assert.equal(r.text, 'Plans start at $40.')

  const byNumber = await onPage()
  const n = await byNumber.b.runStep(byNumber.id, { action: 'click', detail: '#1' })
  assert.deepEqual(byNumber.w.calls.click, [0])
  assert.ok('ok' in n)
  assert.equal(n.text, 'Plans start at $40.')
})

test('a missing name and a duplicate name click nothing and return only the refusal', async () => {
  const { w, b, id } = await onPage()
  assert.deepEqual(await b.runStep(id, { action: 'click', detail: 'Careers' }), { refused: 'missing', name: 'Careers', url: HOME })
  assert.deepEqual(await b.runStep(id, { action: 'click', detail: 'Log' }), { refused: 'ambiguous', name: 'Log', url: HOME })
  assert.deepEqual(await b.runStep(id, { action: 'click', detail: '#99' }), { refused: 'missing', name: '#99', url: HOME })
  assert.deepEqual(w.calls.click, [])
})

test('click named "payment" clicks, because that word is in neither list', async () => {
  assert.equal(payCheck('payment'), null)
  const { w, b, id } = await onPage()
  const r = await b.runStep(id, { action: 'click', detail: 'payment' })
  assert.deepEqual(w.calls.click, [6])
  assert.ok('ok' in r)
})

test('type fills the named field', async () => {
  const { w, b, id } = await onPage()
  const r = await b.runStep(id, { action: 'type', detail: 'Search | summit numbers' })
  assert.deepEqual(w.calls.type, [[2, 'summit numbers']])
  assert.ok('ok' in r)
  assert.deepEqual(await b.runStep(id, { action: 'type', detail: 'Nowhere | x' }), { refused: 'missing', name: 'Nowhere', url: HOME })
  assert.equal(w.calls.type.length, 1)
})

test('pay words: holds keep the full button name, refusals do not click, and nothing is clicked', async () => {
  const { w, b, id } = await onPage(PRICING)
  assert.equal(payCheck('Complete purchase'), 'hold')
  for (const name of ['Pay now', 'Place order', 'Complete purchase', 'Save', 'Apply']) {
    assert.deepEqual(await b.runStep(id, { action: 'click', detail: name }), { hold: 'spend', name, url: PRICING }, name)
  }
  assert.deepEqual(await b.runStep(id, { action: 'click', detail: 'pay NOW' }), { hold: 'spend', name: 'Pay now', url: PRICING })
  for (const name of ['Send message', 'Post', 'Submit']) {
    assert.deepEqual(await b.runStep(id, { action: 'click', detail: name }), { refused: 'pay', name, url: PRICING }, name)
  }
  assert.deepEqual(w.calls.click, [])
})

test('click #1 on a list whose first control is "Pay now" returns that hold and does not click', async () => {
  const { w, b, id } = await onPage(PRICING)
  assert.deepEqual(await b.runStep(id, { action: 'click', detail: '#1' }), { hold: 'spend', name: 'Pay now', url: PRICING })
  assert.deepEqual(w.calls.click, [])
})

test('press Enter submits the form of the last typed field', async () => {
  const { w, b, id } = await onPage()
  await b.runStep(id, { action: 'type', detail: 'Search | summit' })
  const r = await b.runStep(id, { action: 'press', detail: 'Enter' })
  assert.deepEqual(w.calls.submitFor, [2])
  assert.deepEqual(w.calls.submit, [3])
  assert.ok('ok' in r)
})

test('press Enter whose submit control is "Place order" returns a hold and does not press', async () => {
  const { w, b, id } = await onPage(CART)
  await b.runStep(id, { action: 'type', detail: 'Promo code | FALL' })
  assert.deepEqual(await b.runStep(id, { action: 'press', detail: 'Enter' }), { hold: 'spend', name: 'Place order', url: CART })
  assert.deepEqual(w.calls.submit, [])
  assert.deepEqual(w.calls.click, [])
})

test('press Enter when submitFor is null for the last typed field is no-submit and does not press', async () => {
  const { w, b, id } = await onPage(CART)
  await b.runStep(id, { action: 'type', detail: 'Note | hi' })
  assert.deepEqual(await b.runStep(id, { action: 'press', detail: 'Enter' }), { refused: 'no-submit', url: CART })
  assert.deepEqual(w.calls.submitFor, [2])
  assert.deepEqual(w.calls.submit, [])
})

test('press Enter with no type in this browse is no-submit, even when an earlier browse had a type', async () => {
  const { w, b, id } = await onPage()
  await b.runStep(id, { action: 'type', detail: 'Search | summit' })
  b.release(id)
  await b.open('b_2')
  await b.runStep('b_2', { action: 'url', url: HOME })
  assert.deepEqual(await b.runStep('b_2', { action: 'press', detail: 'Enter' }), { refused: 'no-submit', url: HOME })
  assert.deepEqual(w.calls.submitFor, [])
  assert.deepEqual(w.calls.submit, [])

  // A new url in the same browse also leaves the old page's field behind.
  await b.runStep('b_2', { action: 'type', detail: 'Search | summit' })
  await b.runStep('b_2', { action: 'url', url: HOME })
  assert.deepEqual(await b.runStep('b_2', { action: 'press', detail: 'Enter' }), { refused: 'no-submit', url: HOME })
  assert.deepEqual(w.calls.submit, [])
})

test('scroll down is one step; the next page is the lower part of the same text', async () => {
  const { w, b, id, first } = await onPage()
  const r = await b.runStep(id, { action: 'scroll', detail: 'down' })
  assert.deepEqual(w.calls.scroll, ['down'])
  assert.ok('ok' in first && 'ok' in r)
  assert.notEqual(r.text, first.text)
  const start = LONG.lastIndexOf('\n', 6000 - 1) + 1
  assert.equal(r.text, LONG.slice(start, start + r.text.length))
  assert.ok(r.text.length <= BROWSE_TEXT_CHARS)
  assert.equal(LONG[start + r.text.length], '\n')
  assert.deepEqual(r.controls, SITE[HOME].controls)
})

test('a password field is a sign-in: no body text, no further click, the lock moves on, and the window stays open', async () => {
  const { w, b, id } = await onPage(CART)
  let second = false
  const waiting = b.open('b_2').then(() => (second = true))
  await tick()
  assert.equal(second, false)

  const r = await b.runStep(id, { action: 'click', detail: 'Login' })
  assert.deepEqual(r, { signIn: true, url: LOGIN, title: 'Summit' })
  assert.ok(!('text' in r))
  assert.equal(b.windowOpen(), true)
  await waiting
  assert.equal(second, true, 'the session ended, so the next bot gets the lock')

  const clicks = w.calls.click.length
  assert.deepEqual(await b.runStep(id, { action: 'click', detail: 'Continue' }), r)
  assert.equal(w.calls.click.length, clicks)
})

test('a title with "Sign in" is a sign-in page too', async () => {
  const { first } = await onPage(SIGN_IN)
  assert.deepEqual(first, { signIn: true, url: SIGN_IN, title: 'Sign in to Summit' })
})

test('two overlapping opens share one lock: the second waits through the first bot’s later step, until release', async () => {
  const { w, b, id } = await onPage()
  let second = false
  const waiting = b.open('b_2').then(() => (second = true))
  await tick()
  await b.runStep(id, { action: 'click', detail: 'Pricing' })
  await tick()
  assert.equal(second, false)
  b.release(id)
  await waiting
  assert.equal(second, true)
  const r = await b.runStep('b_2', { action: 'url', url: HOME })
  assert.ok('ok' in r)
  assert.equal(w.calls.launch.length, 1)
})

test('a launch that resolves after cancel does not leave the lock held', async () => {
  const w = fakeWindow()
  let finish = () => {}
  const slow: DeskLaunch = (opts) =>
    new Promise((resolve) => {
      finish = () => resolve(w.launch(opts))
    })
  const b = deskBrowser(slow)
  const first = b.open('b_1')
  await tick()
  b.cancel('b_1')
  finish()
  assert.equal(await first, undefined)
  // The lock is free: the next open goes straight through.
  await b.open('b_2')
  const r = await b.runStep('b_2', { action: 'url', url: HOME })
  assert.ok('ok' in r)
  await assert.rejects(b.runStep('b_1', { action: 'url', url: HOME }))
})

test('cancel on a waiting bot: its open returns without the lock, and a late open for that id does not take it', async () => {
  const { b, id } = await onPage()
  const waiting = b.open('b_2')
  await tick()
  b.cancel('b_2')
  assert.equal(await waiting, undefined)
  b.release(id)
  assert.equal(await b.open('b_2'), undefined)
  await assert.rejects(b.runStep('b_2', { action: 'url', url: HOME }))
  // Nobody holds it, so a third bot gets it at once.
  await b.open('b_3')
  assert.ok('ok' in (await b.runStep('b_3', { action: 'url', url: HOME })))
})

test('missing Chrome: open returns noChrome, does not throw, and holds nothing', async () => {
  let launches = 0
  const b = deskBrowser(async () => {
    launches++
    return { noChrome: true }
  })
  assert.deepEqual(await b.open('b_1'), { noChrome: true })
  assert.equal(b.windowOpen(), false)
  assert.deepEqual(await b.open('b_2'), { noChrome: true })
  assert.equal(launches, 2, 'the second open was not stuck behind the first')
  assert.deepEqual(await b.clickApproved('Pay now', PRICING), { noChrome: true })
})

test('clickApproved clicks that control once when the window is open on pageUrl', async () => {
  const { w, b } = await onPage(PRICING)
  const r = await b.clickApproved('Pay now', PRICING)
  assert.deepEqual(w.calls.click, [0])
  assert.ok('ok' in r)
  assert.equal(r.url, CART)
})

test('clickApproved returns page-changed when the window is open on another URL, and does not click', async () => {
  const { w, b } = await onPage(PRICING)
  w.navigate(HOME)
  assert.deepEqual(await b.clickApproved('Pay now', PRICING), { refused: 'page-changed', url: HOME })
  assert.deepEqual(w.calls.click, [])
})

test('clickApproved with no window reopens pageUrl in the desk profile, clicks once, and the window is open', async () => {
  const w = fakeWindow()
  const b = deskBrowser(w.launch)
  assert.equal(b.windowOpen(), false)
  const r = await b.clickApproved('Pay now', PRICING)
  assert.deepEqual(w.calls.launch, [{ chromePath: CHROME, profileDir: deskProfileDir() }])
  assert.deepEqual(w.calls.goto, [PRICING])
  assert.deepEqual(w.calls.click, [0])
  assert.ok('ok' in r)
  assert.equal(b.windowOpen(), true)
})

test('focus raises the corner picture: it does not launch Chrome and does not bring that window forward', async () => {
  const idle = fakeWindow()
  deskBrowser(idle.launch).focus()
  assert.equal(idle.calls.launch.length, 0)
  assert.equal(idle.calls.front, 0)

  const { w, b } = await onPage()
  b.focus()
  assert.equal(w.calls.front, 0)
  assert.equal(w.calls.launch.length, 1)
})

test('showWindow brings the open desk window forward and never launches Chrome', async () => {
  const idle = fakeWindow()
  deskBrowser(idle.launch).showWindow()
  assert.equal(idle.calls.launch.length, 0)
  assert.equal(idle.calls.front, 0)

  const { w, b } = await onPage()
  b.showWindow()
  assert.equal(w.calls.front, 1)
  assert.equal(w.calls.launch.length, 1)

  w.closeWindow()
  b.showWindow()
  assert.equal(w.calls.launch.length, 1)
  assert.equal(w.calls.front, 1)
})

test('picture is a jpeg of the open page, and nothing when that window is closed', async () => {
  const { w, b } = await onPage()
  assert.equal(await b.picture(), null)
  const bytes = new Uint8Array([4, 5, 6])
  w.adapter.shot = async () => bytes
  assert.equal(await b.picture(), Buffer.from(bytes).toString('base64'))
  w.closeWindow()
  assert.equal(await b.picture(), null)
})

test('windowOpen: false before open, true after, still true after release; a closed window opens again on the next browse', async () => {
  const w = fakeWindow()
  const b = deskBrowser(w.launch)
  assert.equal(b.windowOpen(), false)
  await b.open('b_1')
  assert.equal(b.windowOpen(), true)
  b.release('b_1')
  assert.equal(b.windowOpen(), true)

  w.closeWindow()
  assert.equal(b.windowOpen(), false)
  b.focus()
  assert.equal(w.calls.launch.length, 1)
  await b.open('b_2')
  assert.equal(w.calls.launch.length, 2)
  assert.equal(b.windowOpen(), true)
})

test('browser.ts uses payCheck from the shared file and does not split words itself', () => {
  const src = readFileSync(join(import.meta.dirname, 'browser.ts'), 'utf8')
  assert.match(src, /import \{[^}]*\bpayCheck\b[^}]*\} from '\.\.\/\.\.\/shared\/desk\.ts'/)
  assert.doesNotMatch(src, /PAY_HOLD|PAY_REFUSE/)
})
