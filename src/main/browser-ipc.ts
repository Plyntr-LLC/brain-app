import { ipcMain } from 'electron'
import { clickShared, closeShared, faceShared, pressShared, showShared, typeShared, wheelShared } from './shared-browser.ts'

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
}
