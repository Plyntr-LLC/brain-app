import { onlyWebAddress } from '../shared/page-picture.ts'
import { createDeskBrowser } from './desk/browser.ts'
import { makeInAppLaunch } from './desk/inapp.ts'
import type { DeskBrowser, KeyInput, PageFrame, PointerInput } from '../shared/desk.ts'

/**
 * One browser for the app, inside Brain. Every desk controller, every chat, and every chat CLI's
 * brain-browser tools share it, so a login made in one is there for all of them.
 */
let browser: DeskBrowser | null = null
let launch: ReturnType<typeof makeInAppLaunch> | null = null

export function sharedDeskBrowser(): DeskBrowser {
  if (!browser) {
    launch = makeInAppLaunch()
    browser = createDeskBrowser({ launch, chromePath: 'in-app', profileDir: 'in-app' })
  }
  return browser
}

/** On quit: every hidden browser window goes with the app. */
export function closeAllShared(): void {
  launch?.closeAll()
}

/** When the whole message is one web address, open it on that place's window. Other text does nothing. */
export function openSharedPage(text: string, owner = 'page'): Promise<void> {
  const url = onlyWebAddress(text)
  if (!url) return Promise.resolve()
  return sharedDeskBrowser().goTo?.(url, owner) ?? Promise.resolve()
}

export function clickShared(owner: string, x: number, y: number): Promise<void> {
  return sharedDeskBrowser().clickAt?.(x, y, owner) ?? Promise.resolve()
}

export function typeShared(owner: string, text: string): Promise<void> {
  return sharedDeskBrowser().typeText?.(text, owner) ?? Promise.resolve()
}

export function pressShared(owner: string, key: string): Promise<void> {
  return sharedDeskBrowser().pressKey?.(key, owner) ?? Promise.resolve()
}

export function wheelShared(owner: string, deltaY: number): Promise<void> {
  return sharedDeskBrowser().wheel?.(deltaY, owner) ?? Promise.resolve()
}

export function pointerShared(owner: string, ev: PointerInput): Promise<void> {
  return sharedDeskBrowser().pointer?.(owner, ev) ?? Promise.resolve()
}

export function keyShared(owner: string, ev: KeyInput): Promise<void> {
  return sharedDeskBrowser().keyInput?.(owner, ev) ?? Promise.resolve()
}

/** Frames of that place's page for a wide picture. Returns the stop. */
export function watchShared(owner: string, send: (frame: PageFrame) => void): () => void {
  return sharedDeskBrowser().watch?.(owner, send) ?? (() => {})
}

export function showShared(): void {
  sharedDeskBrowser().showWindow()
}

export function closeShared(owner: string): Promise<void> {
  return sharedDeskBrowser().closeOwner?.(owner) ?? Promise.resolve()
}

export async function faceShared(owner: string): Promise<{ src: string | null; signIn: boolean; url?: string; canGoBack?: boolean; canGoForward?: boolean; shared?: boolean }> {
  const b = sharedDeskBrowser()
  const src = (await b.picture(owner)) || null
  const seen = await b.look?.(owner)
  return { src, signIn: !!seen?.signIn, ...(b.facts?.(owner) ?? {}) }
}
