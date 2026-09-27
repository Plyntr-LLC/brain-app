import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { projectBinEnv } from '../ai-cli'
import { factoryCancel, factoryClose, factoryPrompt, factorySetEffort, factoryWarm } from '../acp-session'
import {
  abandonRun,
  commitRunNow,
  configureFactory,
  decideRun,
  detachRun,
  getRun,
  listFactoryRuns,
  pauseRun,
  publishBlockFor,
  publishRun,
  restoreRun,
  resumeRun,
  startRun,
  triageTask,
  type Decision,
  type FactoryEvent
} from './controller'
import { ensureShims, factoryEnv } from './gates'
import { gitTop, isGitRepo } from './git-audit'
import { opusEnv } from './opus'
import { profileLine, readProfile, saveProfile, type ProfilePatch } from './profile'
import { factoryDir, factoryShimDir, setUserDataDir } from './run-store'

function emit(e: FactoryEvent): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('factory:event', e)
  }
}

function prefsFile(): string {
  return join(factoryDir(), 'prefs.json')
}

function lastRepo(): string {
  try {
    return String((JSON.parse(readFileSync(prefsFile(), 'utf8')) as { lastRepo?: string }).lastRepo || '')
  } catch {
    return ''
  }
}

function rememberRepo(path: string): void {
  try {
    mkdirSync(factoryDir(), { recursive: true })
    writeFileSync(prefsFile(), JSON.stringify({ lastRepo: path }))
  } catch {
    /* best effort */
  }
}

/** Profiles key on the repo top, the same folder Start snapshots. */
function repoTop(p: string): string {
  const repo = String(p || '').trim()
  return repo && isGitRepo(repo) ? gitTop(repo) : repo
}

function safe<T>(fn: () => T): T | { ok: false; error: string } {
  try {
    return fn()
  } catch (e) {
    return { ok: false, error: String((e as Error).message || e) }
  }
}

export function registerFactoryIpc(): void {
  setUserDataDir(() => app.getPath('userData'))
  configureFactory({
    driver: {
      warm: (o) => factoryWarm(o),
      prompt: (o) => factoryPrompt(o),
      cancel: (tabId) => void factoryCancel(tabId),
      close: (tabId) => factoryClose(tabId),
      setEffort: (tabId, effort) => factorySetEffort(tabId, effort)
    },
    emit,
    env: (repo) => opusEnv(factoryEnv(projectBinEnv(repo), ensureShims(factoryShimDir())))
  })
  ipcMain.handle('factory:triage', (_e, text: string) => triageTask(String(text || '')))
  ipcMain.handle(
    'factory:start',
    (_e, p: { task: string; workRepo: string; brainPath: string; proceedCritical?: boolean }) =>
      safe(() => {
        const res = startRun({
          task: String(p?.task || ''),
          workRepo: String(p?.workRepo || ''),
          brainPath: String(p?.brainPath || ''),
          proceedCritical: Boolean(p?.proceedCritical)
        })
        if (res.ok) rememberRepo(res.run.workRepo)
        return res
      })
  )
  ipcMain.handle('factory:resume', (_e, id: string) => safe(() => ({ ok: true as const, run: resumeRun(String(id)) })))
  ipcMain.handle('factory:decide', (_e, id: string, choice: Decision, opts?: { reason?: string }) =>
    safe(() => ({ ok: true as const, run: decideRun(String(id), choice, { reason: String(opts?.reason || '') }) }))
  )
  ipcMain.handle('factory:profile', (_e, repo: string) =>
    safe(() => {
      const p = readProfile(repoTop(repo))
      return { ok: true as const, profile: p, line: profileLine(p) }
    })
  )
  ipcMain.handle('factory:saveProfile', (_e, repo: string, patch: ProfilePatch) =>
    safe(() => {
      const p = saveProfile(repoTop(repo), { voice: patch?.voice, scripts: patch?.scripts, publish: patch?.publish })
      return { ok: true as const, profile: p, line: profileLine(p) }
    })
  )
  ipcMain.handle('factory:publish', async (_e, id: string) => {
    try {
      return { ok: true as const, run: await publishRun(String(id)) }
    } catch (e) {
      return { ok: false as const, error: String((e as Error).message || e) }
    }
  })
  ipcMain.handle('factory:publishBlock', (_e, id: string) => safe(() => ({ ok: true as const, block: publishBlockFor(String(id)) })))
  ipcMain.handle('factory:commit', (_e, id: string) => safe(() => ({ ok: true as const, run: commitRunNow(String(id)) })))
  ipcMain.handle('factory:pause', (_e, id: string) => safe(() => ({ ok: true as const, run: pauseRun(String(id)) })))
  ipcMain.handle('factory:detach', (_e, id: string) => safe(() => ({ ok: true as const, run: detachRun(String(id)) })))
  ipcMain.handle('factory:abandon', (_e, id: string) => safe(() => ({ ok: true as const, run: abandonRun(String(id)) })))
  ipcMain.handle('factory:list', () => safe(() => listFactoryRuns()))
  ipcMain.handle('factory:get', (_e, id: string) => safe(() => restoreRun(String(id)) || getRun(String(id))))
  ipcMain.handle('factory:lastRepo', () => lastRepo())
  ipcMain.handle('factory:pickRepo', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const opts = {
      title: 'Choose the work repo',
      defaultPath: lastRepo() || undefined,
      properties: ['openDirectory'] as Array<'openDirectory'>
    }
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (r.canceled || !r.filePaths[0]) return null
    rememberRepo(r.filePaths[0])
    return r.filePaths[0]
  })
}
