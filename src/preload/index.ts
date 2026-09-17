import { contextBridge, ipcRenderer } from 'electron'
import type { AiKind } from '../shared/contracts'

const brain = {
  env: () => ipcRenderer.invoke('env:get') as Promise<{ dryRun: boolean }>,
  auth: {
    resolveCode: (code: string) => ipcRenderer.invoke('auth:resolveCode', code),
    requestCode: (email: string) => ipcRenderer.invoke('auth:requestCode', email),
    verify: (email: string, code: string) => ipcRenderer.invoke('auth:verify', email, code),
    myTeams: () => ipcRenderer.invoke('auth:myTeams')
  },
  setup: {
    createTeam: (name: string) => ipcRenderer.invoke('setup:createTeam', name),
    lookupOrg: (login: string) => ipcRenderer.invoke('setup:lookupOrg', login),
    openCreateOrg: () => ipcRenderer.invoke('setup:openCreateOrg'),
    openAppInstall: (slug: string, org?: string) =>
      ipcRenderer.invoke('setup:openAppInstall', slug, org),
    pollInstall: (slug: string) => ipcRenderer.invoke('setup:pollInstall', slug),
    ensureRepo: (slug: string) => ipcRenderer.invoke('setup:ensureRepo', slug),
    applyFolder: (opts: unknown) => ipcRenderer.invoke('setup:applyFolder', opts)
  },
  ab: {
    detect: () => ipcRenderer.invoke('ab:detect'),
    install: () => ipcRenderer.invoke('ab:install'),
    watching: () => ipcRenderer.invoke('ab:watching')
  },
  ai: {
    detect: () => ipcRenderer.invoke('ai:detect'),
    login: (which: AiKind) => ipcRenderer.invoke('ai:login', which)
  },
  chat: {
    send: (text: string) => ipcRenderer.invoke('chat:send', text),
    needs: () => ipcRenderer.invoke('chat:needs')
  }
}

contextBridge.exposeInMainWorld('brain', brain)

export type BrainApi = typeof brain

declare global {
  interface Window {
    brain: BrainApi
  }
}
