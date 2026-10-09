import { ipcMain, type WebContents } from 'electron'
import type { KeyInput, PointerInput } from '../shared/desk.ts'
import { clickShared, closeShared, faceShared, keyShared, pointerShared, pressShared, showShared, typeShared, watchShared, wheelShared } from './shared-browser.ts'

/** One stop per window and place that asked for frames. */
const watching = new Map<WebContents, Map<string, () => void>>()

function setWatch(sender: WebContents, owner: string, on: boolean) {
  let mine = watching.get(sender)
  if (!mine) {
    mine = new Map()
    watching.set(sender, mine)
    sender.once('destroyed', () => {
      for (const stop of watching.get(sender)?.values() ?? []) stop()
      watching.delete(sender)
    })
  }
  mine.get(owner)?.()
  mine.delete(owner)
  if (!on || !owner) return
  mine.set(
    owner,
    watchShared(owner, (frame) => {
      if (!sender.isDestroyed()) sender.send('browser:frame', { owner, ...frame })
    })
  )
}

/** The in-app picture. Chat and Desk both call these. The owner names the window. */
export function registerBrowserIpc(): void {
  ipcMain.handle('browser:face', (_e, owner: string) => faceShared(String(owner || '')))
  ipcMain.handle('browser:clickAt', (_e, owner: string, x: number, y: number) => clickShared(String(owner || ''), Number(x), Number(y)))
  ipcMain.handle('browser:typeText', (_e, owner: string, text: string) => typeShared(String(owner || ''), String(text || '')))
  ipcMain.handle('browser:pressKey', (_e, owner: string, key: string) => pressShared(String(owner || ''), String(key || '')))
  ipcMain.handle('browser:wheel', (_e, owner: string, deltaY: number) => wheelShared(String(owner || ''), Number(deltaY) || 0))
  ipcMain.handle('browser:showWindow', () => {
    showShared()
  })
  ipcMain.handle('browser:close', (_e, owner: string) => closeShared(String(owner || '')))
  ipcMain.handle('browser:watch', (e, owner: string, on: boolean) => setWatch(e.sender, String(owner || ''), !!on))
  ipcMain.handle('browser:pointer', (_e, owner: string, ev: PointerInput) => pointerShared(String(owner || ''), ev))
  ipcMain.handle('browser:key', (_e, owner: string, ev: KeyInput) => keyShared(String(owner || ''), ev))
}
