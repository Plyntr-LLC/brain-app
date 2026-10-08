import puppeteer from 'puppeteer-core'
import { onlyWebAddress } from '../shared/page-picture.ts'
import { createDeskBrowser } from './desk/browser.ts'
import { deskProfileDir, macChromePath, makeDeskLaunch } from './desk/chrome.ts'
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

export function showShared(): void {
  sharedDeskBrowser().showWindow()
}

export function closeShared(owner: string): Promise<void> {
  return sharedDeskBrowser().closeOwner?.(owner) ?? Promise.resolve()
}

export async function faceShared(owner: string): Promise<{ src: string | null; signIn: boolean }> {
  const b = sharedDeskBrowser()
  const src = (await b.picture(owner)) || null
  const seen = await b.look?.(owner)
  return { src, signIn: !!seen?.signIn }
}
