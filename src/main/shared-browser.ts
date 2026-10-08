import puppeteer from 'puppeteer-core'
import { onlyWebAddress } from '../shared/page-picture.ts'
import { createDeskBrowser } from './desk/browser.ts'
import { deskProfileDir, macChromePath, makeDeskLaunch } from './desk/chrome.ts'
import { startPageTurn } from './desk/page-lane.ts'
import type { DeskBrowser } from '../shared/desk.ts'

/**
 * One Chrome for the app. Every desk controller and every chat shares this launch.
 * A second puppeteer.launch on the desk profile does not happen.
 */
let browser: DeskBrowser | null = null

export function sharedDeskBrowser(): DeskBrowser {
  if (!browser) {
    browser = createDeskBrowser({
      launch: makeDeskLaunch(puppeteer.launch),
      chromePath: macChromePath(),
      profileDir: deskProfileDir()
    })
  }
  return browser
}

/** When the whole message is one web address, open it. Other text does nothing. */
export function openSharedPage(text: string): Promise<void> {
  const url = onlyWebAddress(text)
  if (!url) return Promise.resolve()
  const turn = startPageTurn()
  return (async () => {
    try {
      if (!(await turn.promise)) return
      await sharedDeskBrowser().goTo?.(url)
    } finally {
      turn.release()
    }
  })()
}

async function withTurn(run: () => Promise<void>): Promise<void> {
  const turn = startPageTurn()
  try {
    if (!(await turn.promise)) return
    await run()
  } finally {
    turn.release()
  }
}

export function clickShared(x: number, y: number): Promise<void> {
  return withTurn(() => sharedDeskBrowser().clickAt?.(x, y) ?? Promise.resolve())
}

export function typeShared(text: string): Promise<void> {
  return withTurn(() => sharedDeskBrowser().typeText?.(text) ?? Promise.resolve())
}

export function pressShared(key: string): Promise<void> {
  return withTurn(() => sharedDeskBrowser().pressKey?.(key) ?? Promise.resolve())
}

export function wheelShared(deltaY: number): Promise<void> {
  return withTurn(() => sharedDeskBrowser().wheel?.(deltaY) ?? Promise.resolve())
}

export function showShared(): void {
  sharedDeskBrowser().showWindow()
}

export async function faceShared(): Promise<{ src: string | null; signIn: boolean }> {
  const b = sharedDeskBrowser()
  const src = (await b.picture()) || null
  const seen = await b.look?.()
  return { src, signIn: !!seen?.signIn }
}
