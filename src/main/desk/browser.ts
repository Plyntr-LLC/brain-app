import { BROWSE_MAX_CONTROLS, BROWSE_TEXT_CHARS, payCheck } from '../../shared/desk.ts'
import type { BrowseStepResult, DeskBrowser, DeskLaunch, PageSnapshot } from '../../shared/desk.ts'
import type { DeskPage } from './chrome.ts'
import { startPageTurn } from './page-lane.ts'

/**
 * The one desk browser. One browse at a time: a session is the lock, the browseId, and the open page,
 * and they end together. Each step returns the page or a refusal. The controller writes every
 * sentence; this file returns only results.
 */

type Step = { action: string; detail?: string; url?: string }
type Session = { id: string; page: PageSnapshot | null; field: { index: number; control: string } | null }

const SIGN_IN_TITLE = /\b(sign|log)[\s-]?in\b/i

/** "link Pricing" is named Pricing. A line with no kind word is all name. */
function controlName(control: string): string {
  const m = /^(link|button|field) (.*)$/.exec(control)
  return m ? m[2] : control
}

const same = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase()

/** The one control `target` names: `#3` is the third on the list, else its name or its whole line ("link Pricing"). */
function findControl(controls: string[], target: string, fieldsFirst = false): number | 'missing' | 'ambiguous' {
  const n = /^#\s*(\d+)$/.exec(target.trim())
  if (n) {
    const i = Number(n[1]) - 1
    return i >= 0 && i < controls.length ? i : 'missing'
  }
  const key = same(target)
  if (!key) return 'missing'
  let hits = controls.flatMap((c, i) => (same(controlName(c)) === key || same(c) === key ? [i] : []))
  if (fieldsFirst && hits.length > 1) {
    const fields = hits.filter((i) => controls[i].startsWith('field '))
    if (fields.length) hits = fields
  }
  if (!hits.length) return 'missing'
  return hits.length > 1 ? 'ambiguous' : hits[0]
}

/** The typed field's number on the current list. It moves when the page re-numbered. */
function fieldNow(controls: string[], field: { index: number; control: string }): number | null {
  if (controls[field.index] === field.control) return field.index
  const i = controls.indexOf(field.control)
  return i >= 0 ? i : null
}

export function createDeskBrowser(opts: { launch: DeskLaunch; chromePath: string; profileDir: string }): DeskBrowser {
  const { launch, chromePath, profileDir } = opts
  let adapter: DeskPage | null = null
  let launching: ReturnType<DeskLaunch> | null = null
  let holder: string | null = null
  let session: Session | null = null
  let signedOut: { id: string; result: BrowseStepResult } | null = null
  const waiters: { id: string; go: () => void }[] = []
  const cancelled = new Set<string>()

  const windowOpen = () => !!adapter && !adapter.closed?.()

  /** The desk window, launched once and kept. A window the person closed launches again. */
  async function chrome(): Promise<DeskPage | { noChrome: true }> {
    if (adapter && windowOpen()) return adapter
    launching ??= launch({ chromePath, profileDir }).finally(() => {
      launching = null
    })
    const got = await launching
    if ('noChrome' in got) return got
    adapter = got
    return got
  }

  /** Ends the holder's session and hands the lock to the next bot in line. */
  function handOn() {
    holder = null
    session = null
    const next = waiters.shift()
    if (!next) return
    holder = next.id
    next.go()
  }

  function dropWaiter(browseId: string) {
    const i = waiters.findIndex((w) => w.id === browseId)
    if (i >= 0) waiters.splice(i, 1)[0].go()
  }

  async function open(browseId: string): Promise<void | { noChrome: true }> {
    if (cancelled.has(browseId) || holder === browseId) return
    if (holder !== null) {
      await new Promise<void>((go) => waiters.push({ id: browseId, go }))
      if (holder !== browseId) return
    } else {
      holder = browseId
    }
    let got: DeskPage | { noChrome: true }
    try {
      got = await chrome()
    } catch (e) {
      if (holder === browseId) handOn()
      throw e
    }
    // Released or cancelled while Chrome was starting: the lock moves on.
    if (holder !== browseId) return
    if (cancelled.has(browseId) || 'noChrome' in got) {
      handOn()
      return 'noChrome' in got ? got : undefined
    }
    session = { id: browseId, page: null, field: null }
  }

  function cancel(browseId: string) {
    cancelled.add(browseId)
    dropWaiter(browseId)
    // While Chrome is still starting, open sees the mark and lets go itself.
    if (holder === browseId && session) handOn()
  }

  function release(browseId: string) {
    if (holder === browseId) handOn()
    else dropWaiter(browseId)
  }

  function focus() {
    // The corner picture lives in the Desk window. This must not launch Chrome or bring it forward.
  }

  function showWindow() {
    if (adapter && windowOpen()) void adapter.front?.().catch(() => {})
  }

  async function picture(): Promise<string | null> {
    if (!adapter || !windowOpen() || !adapter.shot) return null
    try {
      const bytes = await adapter.shot()
      if (!bytes?.byteLength) return null
      return Buffer.from(bytes).toString('base64')
    } catch {
      return null
    }
  }

  /** Reads the page after a step. A sign-in page ends the session; the window stays open. */
  async function read(a: DeskPage, s: Session | null): Promise<BrowseStepResult> {
    const p = await a.snapshot()
    if (p.hasPassword || SIGN_IN_TITLE.test(p.title)) {
      const result: BrowseStepResult = { signIn: true, url: p.url, title: p.title }
      if (s && holder === s.id) {
        signedOut = { id: s.id, result }
        handOn()
      }
      return result
    }
    const text = p.text.slice(0, BROWSE_TEXT_CHARS)
    const controls = p.controls.slice(0, BROWSE_MAX_CONTROLS)
    if (s) s.page = { ...p, text, controls }
    return { ok: true, url: p.url, title: p.title, text, controls }
  }

  /** The pay check runs on the control's name before anything is clicked or pressed. */
  function payStop(name: string, url: string): BrowseStepResult | null {
    const pay = payCheck(name)
    if (pay === 'hold') return { hold: 'spend', name, url }
    if (pay === 'refuse') return { refused: 'pay', name, url }
    return null
  }

  async function page(): Promise<DeskPage | { noChrome: true } | null> {
    if (!adapter || !windowOpen()) return null
    return adapter
  }

  async function goTo(url: string) {
    const a = await chrome()
    if ('noChrome' in a) return
    await a.goto(url)
  }

  async function clickAt(x: number, y: number) {
    const a = await page()
    if (!a || 'noChrome' in a) return
    await a.clickAt?.(x, y)
  }

  async function typeText(text: string) {
    const a = await page()
    if (!a || 'noChrome' in a) return
    await a.typeText?.(text)
  }

  async function pressKey(key: string) {
    const a = await page()
    if (!a || 'noChrome' in a) return
    await a.pressKey?.(key)
  }

  async function wheel(deltaY: number) {
    const a = await page()
    if (!a || 'noChrome' in a) return
    await a.wheel?.(deltaY)
  }

  async function look(): Promise<{ signIn: boolean } | null> {
    const a = await page()
    if (!a || 'noChrome' in a) return null
    try {
      const p = await a.snapshot()
      return { signIn: p.hasPassword || SIGN_IN_TITLE.test(p.title) }
    } catch {
      return { signIn: false }
    }
  }

  async function runStep(browseId: string, step: Step): Promise<BrowseStepResult> {
    const action = step.action.toLowerCase()
    const detail = (step.detail ?? '').trim()
    const mutates = action === 'url' || action === 'click' || action === 'type' || action === 'press' || action === 'scroll'
    const turn = mutates ? startPageTurn() : null
    try {
      if (turn && !(await turn.promise)) return { refused: 'missing', name: (step.url ?? detail).trim(), url: session?.page?.url ?? '' }
      if (signedOut?.id === browseId) return signedOut.result
      const s = session
      // The controller posts no-page before it gets here. This is a wiring bug, not a sentence.
      if (!s || s.id !== browseId) throw new Error(`desk browser: runStep for ${browseId} without an open session`)
      const a = await chrome()
      if ('noChrome' in a) return a

    if (action === 'url') {
      const url = (step.url ?? detail).trim()
      if (!/^https?:\/\//i.test(url)) return { refused: 'missing', name: url, url: s.page?.url ?? '' }
      s.field = null
      await a.goto(url)
      return read(a, s)
    }
    if (!s.page) throw new Error(`desk browser: ${action} for ${browseId} before its url step`)
    const { controls, url } = s.page

    if (action === 'click') {
      const hit = findControl(controls, detail)
      if (typeof hit !== 'number') return { refused: hit, name: detail, url }
      const name = controlName(controls[hit])
      const stop = payStop(name, url)
      if (stop) return stop
      await a.click(hit)
      return read(a, s)
    }
    if (action === 'type') {
      const bar = detail.indexOf('|')
      const target = bar < 0 ? detail : detail.slice(0, bar).trim()
      const hit = findControl(controls, target, true)
      if (typeof hit !== 'number') return { refused: hit, name: target, url }
      await a.type(hit, bar < 0 ? '' : detail.slice(bar + 1).trim())
      s.field = { index: hit, control: controls[hit] }
      return read(a, s)
    }
    if (action === 'press') {
      const field = s.field && fieldNow(controls, s.field)
      const sub = typeof field === 'number' ? await a.submitFor(field) : null
      if (!sub) return { refused: 'no-submit', url }
      const stop = payStop(sub.name, url)
      if (stop) return stop
      await a.submit(sub.index)
      return read(a, s)
    }
    if (action === 'scroll') {
      await a.scroll(detail.toLowerCase() === 'up' ? 'up' : 'down')
      return read(a, s)
    }
    return { refused: 'missing', name: detail, url }
    } finally {
      turn?.release()
    }
  }

  /** Approve on a browser hold: one click on `name`, only on `pageUrl`. With the window closed it
   * reopens `pageUrl` in the desk profile first. The person already said yes, so no pay check. */
  async function clickApproved(name: string, pageUrl: string): Promise<BrowseStepResult> {
    const turn = startPageTurn()
    try {
      if (!(await turn.promise)) return { refused: 'missing', name, url: pageUrl }
      const wasOpen = windowOpen()
      const a = await chrome()
      if ('noChrome' in a) return a
      if (!wasOpen) await a.goto(pageUrl)
      const p = await a.snapshot()
      if (p.url !== pageUrl) return { refused: 'page-changed', url: p.url }
      if (p.hasPassword || SIGN_IN_TITLE.test(p.title)) return { signIn: true, url: p.url, title: p.title }
      const hit = findControl(p.controls, name)
      if (typeof hit !== 'number') return { refused: hit, name, url: p.url }
      await a.click(hit)
      return read(a, session)
    } finally {
      turn.release()
    }
  }

  return { open, cancel, release, focus, showWindow, picture, windowOpen, clickApproved, runStep, goTo, clickAt, typeText, pressKey, wheel, look }
}
