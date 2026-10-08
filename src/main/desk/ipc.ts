import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { app, BrowserWindow, ipcMain } from 'electron'
import type { BotState, DeskBot, DeskCli, DeskMessage, DeskWelcome } from '../../shared/desk.ts'
import { binEnv, detect, resolveBin } from '../ai-cli.ts'
import { plyntrOwnerProfile } from '../agency-brain.ts'
import { brainIdForFolder, roleForKeylessWrite } from '../plyntr-seats.ts'
import { loadAccount } from '../session-token.ts'
import { roleForBrainWrite } from '../write-guard-role.ts'
import { createDeskController } from './controller.ts'
import type { DeskController } from './controller.ts'
import { createDeskRunner } from './runner.ts'
import { seedDesk } from './seed.ts'
import { createSenders } from './senders.ts'
import { buildWelcome, deskGreeting } from './welcome.ts'
import { registerBrowserIpc } from '../browser-ipc.ts'
import { sharedDeskBrowser } from '../shared-browser.ts'

/**
 * One controller per brain folder. The renderer attaches a Desk tab, asks
 * closeCheck before it closes, then detach. Stop runs only when this tab is
 * the last one and the close asked to stop.
 */

export type DeskSnapshot = {
  brain: string
  messages: DeskMessage[]
  states: BotState[]
  removedNames: Record<string, string>
}

export type DeskHostDeps = {
  open(brain: string): DeskController
  detect: () => Record<DeskCli, boolean>
  greetingName(): string | null
  emit?(snap: DeskSnapshot): void
}

/** The role Chat already passes to brainWriteBlock for this folder. */
export function deskWriteRole(folder: string): string {
  return brainIdForFolder(folder) ? roleForBrainWrite(folder) : roleForKeylessWrite(folder)
}

function brainKey(folder: string): string {
  const abs = resolve(folder)
  try {
    return realpathSync(abs)
  } catch {
    return abs
  }
}

function deskDetect(): Record<DeskCli, boolean> {
  return detect()
}

/** The live controller: desk Chrome through makeDeskLaunch, senders in dry-run when the env says so. */
export function openDeskController(brain: string): DeskController {
  const role = deskWriteRole(brain)
  seedDesk({ brain, role, detect: deskDetect })
  return createDeskController({
    brain,
    role,
    runner: createDeskRunner({ resolveBin, binEnv, detect: deskDetect }),
    browser: sharedDeskBrowser(),
    senders: createSenders({
      dryRun: process.env.BRAIN_APP_DRY_RUN === '1',
      getAppPath: () => app.getAppPath(),
      resourcesPath: () => process.resourcesPath
    }),
    detect: deskDetect
  })
}

export function createDeskHost(deps: DeskHostDeps) {
  const controllers = new Map<string, DeskController>()
  const tabs = new Map<string, { brain: string }>()

  function snapshot(brain: string) {
    const controller = controllers.get(brain)
    if (!controller || !deps.emit) return
    deps.emit({
      brain,
      messages: controller.view(null),
      states: controller.states(),
      removedNames: controller.list().removedNames
    })
  }

  function watch(controller: DeskController, brain: string) {
    const orig = controller.store.appendMail.bind(controller.store)
    controller.store.appendMail = (input) => {
      const res = orig(input)
      snapshot(brain)
      queueMicrotask(() => snapshot(brain))
      return res
    }
  }

  function controllerFor(tab: string): DeskController {
    const rec = tabs.get(tab)
    const controller = rec ? controllers.get(rec.brain) : undefined
    if (!rec || !controller) throw new Error("Desk isn't open.")
    return controller
  }

  function attach(tab: string, brain: string) {
    const key = brainKey(brain)
    tabs.set(tab, { brain: key })
    if (controllers.has(key)) return { brain: key }
    const created = deps.open(key)
    controllers.set(key, created)
    watch(created, key)
    void created.open()
    return { brain: key }
  }

  function closeCheck(tab: string): { last: boolean; busyNames: string[] } {
    const rec = tabs.get(tab)
    if (!rec) return { last: false, busyNames: [] }
    const count = [...tabs.values()].filter((t) => t.brain === rec.brain).length
    const controller = controllers.get(rec.brain)
    return { last: count === 1, busyNames: controller ? controller.anyBusy() : [] }
  }

  async function detach(tab: string, opts: { stop: boolean }) {
    const rec = tabs.get(tab)
    if (!rec) return
    tabs.delete(tab)
    const still = [...tabs.values()].some((t) => t.brain === rec.brain)
    if (still || !opts.stop) return
    const controller = controllers.get(rec.brain)
    if (controller) await controller.closeDesk()
    controllers.delete(rec.brain)
  }

  async function quitAll() {
    const all = [...controllers.values()]
    for (const controller of all) await controller.quit()
    controllers.clear()
    tabs.clear()
  }

  function welcome(tab: string, thread?: string | null): DeskWelcome {
    const controller = controllerFor(tab)
    const rec = tabs.get(tab)
    return buildWelcome({
      brain: rec?.brain || '',
      bots: controller.list().bots,
      detect: deps.detect,
      greetingName: deps.greetingName(),
      thread
    })
  }

  return {
    attach,
    closeCheck,
    detach,
    quitAll,
    welcome,
    list: (tab: string) => controllerFor(tab).list(),
    save: (tab: string, bot: Omit<DeskBot, 'file'>) => controllerFor(tab).saveBot(bot),
    remove: (tab: string, id: string) => controllerFor(tab).removeBot(id),
    say: (tab: string, text: string, to?: string, pastes?: { token: string; text: string }[]) => controllerFor(tab).say(text, to, pastes),
    answerHold: (tab: string, id: string, answer: 'yes' | 'no') => controllerFor(tab).answerHold(id, answer),
    answerEmail: (tab: string, id: string, answer: 'yes' | 'no') => controllerFor(tab).answerEmail(id, answer),
    answerText: (tab: string, id: string, answer: 'yes' | 'no') => controllerFor(tab).answerText(id, answer),
    stop: (tab: string, botId: string) => controllerFor(tab).stop(botId),
    keepWaiting: (tab: string, botId: string) => controllerFor(tab).keepWaiting(botId),
    continueJob: (tab: string, job: string) => controllerFor(tab).continueJob(job),
    stopJob: (tab: string, job: string) => controllerFor(tab).stopJob(job),
    retry: (tab: string, msgId: string) => controllerFor(tab).retry(msgId),
    status: (tab: string) => controllerFor(tab).status(),
    focus: (tab: string) => controllerFor(tab).focus(),
    showWindow: (tab: string) => controllerFor(tab).showWindow(),
    picture: (tab: string, botId?: string) => controllerFor(tab).picture(botId),
    view: (tab: string, botId: string | null) => controllerFor(tab).view(botId),
    opened: () => controllers.size
  }
}

export function registerDeskIpc(): void {
  const host = createDeskHost({
    open: openDeskController,
    detect: deskDetect,
    greetingName: () => deskGreeting(loadAccount(), plyntrOwnerProfile()),
    emit(snap) {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send('desk:event', snap)
      }
    }
  })
  ipcMain.handle('desk:attach', (_e, tab: string, brain: string) => host.attach(String(tab || ''), String(brain || '')))
  ipcMain.handle('desk:closeCheck', (_e, tab: string) => host.closeCheck(String(tab || '')))
  ipcMain.handle('desk:detach', (_e, tab: string, opts: { stop?: boolean }) => host.detach(String(tab || ''), { stop: Boolean(opts?.stop) }))
  ipcMain.handle('desk:welcome', (_e, tab: string, thread?: string | null) => host.welcome(String(tab || ''), thread))
  ipcMain.handle('desk:list', (_e, tab: string) => host.list(String(tab || '')))
  ipcMain.handle('desk:save', (_e, tab: string, bot: Omit<DeskBot, 'file'>) => host.save(String(tab || ''), bot))
  ipcMain.handle('desk:remove', (_e, tab: string, id: string) => host.remove(String(tab || ''), String(id || '')))
  ipcMain.handle('desk:say', (_e, tab: string, text: string, to?: string, pastes?: { token: string; text: string }[]) =>
    host.say(String(tab || ''), String(text || ''), typeof to === 'string' ? to : undefined, Array.isArray(pastes) ? pastes : undefined)
  )
  ipcMain.handle('desk:answerHold', (_e, tab: string, id: string, answer: 'yes' | 'no') =>
    host.answerHold(String(tab || ''), String(id || ''), answer === 'no' ? 'no' : 'yes')
  )
  ipcMain.handle('desk:answerEmail', (_e, tab: string, id: string, answer: 'yes' | 'no') =>
    host.answerEmail(String(tab || ''), String(id || ''), answer === 'no' ? 'no' : 'yes')
  )
  ipcMain.handle('desk:answerText', (_e, tab: string, id: string, answer: 'yes' | 'no') =>
    host.answerText(String(tab || ''), String(id || ''), answer === 'no' ? 'no' : 'yes')
  )
  ipcMain.handle('desk:stop', (_e, tab: string, botId: string) => host.stop(String(tab || ''), String(botId || '')))
  ipcMain.handle('desk:keepWaiting', (_e, tab: string, botId: string) => host.keepWaiting(String(tab || ''), String(botId || '')))
  ipcMain.handle('desk:continueJob', (_e, tab: string, job: string) => host.continueJob(String(tab || ''), String(job || '')))
  ipcMain.handle('desk:stopJob', (_e, tab: string, job: string) => host.stopJob(String(tab || ''), String(job || '')))
  ipcMain.handle('desk:retry', (_e, tab: string, msgId: string) => host.retry(String(tab || ''), String(msgId || '')))
  ipcMain.handle('desk:status', (_e, tab: string) => host.status(String(tab || '')))
  ipcMain.handle('desk:focus', (_e, tab: string) => host.focus(String(tab || '')))
  ipcMain.handle('desk:showWindow', (_e, tab: string) => host.showWindow(String(tab || '')))
  ipcMain.handle('desk:picture', (_e, tab: string, botId?: string) => host.picture(String(tab || ''), botId ? String(botId) : undefined))
  registerBrowserIpc()
  ipcMain.handle('desk:view', (_e, tab: string, botId: string | null) => host.view(String(tab || ''), botId || null))
  app.on('before-quit', () => {
    void host.quitAll()
  })
}
