import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { AiKind } from '../shared/contracts'

const brain = {
  quit: () => ipcRenderer.invoke('app:quit'),
  env: () =>
    ipcRenderer.invoke('env:get') as Promise<{
      dryRun: boolean
      chatLive: boolean
      existingBrain: {
        brainPath: string | null
        name: string | null
        email: string | null
        watching: boolean
      }
    }>,
  bridge: {
    load: () => ipcRenderer.invoke('bridge:load') as Promise<Record<string, unknown> | null>,
    save: (data: unknown) => ipcRenderer.invoke('bridge:save', data) as Promise<{ ok: boolean }>,
    openUrl: (url: string) => ipcRenderer.invoke('bridge:openUrl', url) as Promise<{ ok: boolean }>
  },
  settings: {
    get: () =>
      ipcRenderer.invoke('settings:get') as Promise<{
        superAdmin: boolean
        email: string
        watching: boolean
        brainPath: string | null
        brainName: string | null
        brainSlug: string | null
        plyntrBrain: boolean
      }>,
    setSuper: (on: boolean) => ipcRenderer.invoke('settings:setSuper', on),
    team: () =>
      ipcRenderer.invoke('settings:team') as Promise<
        { name: string; email: string; role: 'owner' | 'scout' | 'team'; brain: string; client?: string }[]
      >,
    saveTeam: (
      people: {
        name: string
        email: string
        role: 'owner' | 'scout' | 'team'
        brain: string
        client?: string
      }[]
    ) => ipcRenderer.invoke('settings:saveTeam', people),
    clients: () => ipcRenderer.invoke('settings:clients') as Promise<Record<string, unknown>[]>,
    saveClients: (clients: unknown[]) => ipcRenderer.invoke('settings:saveClients', clients)
  },
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
    applyFolder: (opts: unknown) => ipcRenderer.invoke('setup:applyFolder', opts),
    status: () =>
      ipcRenderer.invoke('setup:status') as Promise<{
        ready: boolean
        watching: boolean
        items: {
          id: string
          label: string
          line: string
          present: boolean
          warn: string
          accept: string
        }[]
      }>,
    install: (id: string) =>
      ipcRenderer.invoke('setup:install', id) as Promise<{
        ok: boolean
        detail: string
        wait: 'none' | 'present' | 'watching'
      }>
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
  pty: {
    create: (opts: {
      id: string
      kind?: AiKind
      cwd: string
      cols: number
      rows: number
      sessionId?: string
      shell?: boolean
    }) => ipcRenderer.invoke('pty:create', opts),
    write: (id: string, data: string) => ipcRenderer.invoke('pty:write', id, data),
    resize: (id: string, cols: number, rows: number) => ipcRenderer.invoke('pty:resize', id, cols, rows),
    kill: (id: string) => ipcRenderer.invoke('pty:kill', id),
    onData: (cb: (ev: { id: string; data: string }) => void) => {
      const h = (_: unknown, ev: { id: string; data: string }) => cb(ev)
      ipcRenderer.on('pty:data', h)
      return () => ipcRenderer.removeListener('pty:data', h)
    },
    onExit: (cb: (ev: { id: string; exitCode: number }) => void) => {
      const h = (_: unknown, ev: { id: string; exitCode: number }) => cb(ev)
      ipcRenderer.on('pty:exit', h)
      return () => ipcRenderer.removeListener('pty:exit', h)
    }
  },
  files: {
    tree: (root?: string) => ipcRenderer.invoke('files:tree', root),
    list: (root: string, dir?: string) =>
      ipcRenderer.invoke('files:list', root, dir) as Promise<{ name: string; path: string; dir: boolean }[]>,
    match: (cwd: string, text: string) =>
      ipcRenderer.invoke('files:match', cwd, text) as Promise<{ path: string; live?: boolean }[]>,
    read: (root: string, abs: string) =>
      ipcRenderer.invoke('files:read', root, abs) as Promise<{ text: string; kind: 'md' | 'html' | 'text'; name: string }>,
    browse: (root?: string) =>
      ipcRenderer.invoke('files:browse', root) as Promise<{ path: string; name: string }[]>,
    fileUrl: (root: string, abs: string) => ipcRenderer.invoke('files:fileUrl', root, abs) as Promise<string>,
    recents: () =>
      ipcRenderer.invoke('files:recents') as Promise<{ path: string; name: string; watching?: boolean }[]>,
    remember: (folder: string) =>
      ipcRenderer.invoke('files:remember', folder) as Promise<{ path: string; name: string }>,
    pickFolder: () =>
      ipcRenderer.invoke('files:pickFolder') as Promise<{ path: string; name: string } | null>,
    pick: () =>
      ipcRenderer.invoke('files:pick') as Promise<{
        files: { path: string; name: string; mime: string }[]
        skipped: string[]
      }>,
    saveText: (suggested: string, text: string) =>
      ipcRenderer.invoke('files:saveText', suggested, text) as Promise<string | null>,
    pathFor: (file: File) => {
      try {
        return webUtils.getPathForFile(file as File) || ''
      } catch {
        return ''
      }
    },
    stash: (name: string, bytes: Uint8Array, mime: string) =>
      ipcRenderer.invoke('files:stash', name, bytes, mime) as Promise<{ path: string; name: string; mime: string }>
  },
  slash: {
    list: (cwd?: string, kind?: string) =>
      ipcRenderer.invoke('slash:list', cwd, kind) as Promise<{
        commands: { name: string; kind: 'builtin' | 'skill'; description: string }[]
        models: { id: string; label: string }[]
      }>,
    context: (cwd?: string) => ipcRenderer.invoke('slash:context', cwd) as Promise<string>,
    usage: (cwd?: string, kind?: string) => ipcRenderer.invoke('slash:usage', cwd, kind) as Promise<string>,
    sessions: (cwd?: string) =>
      ipcRenderer.invoke('slash:sessions', cwd) as Promise<{ id: string; title: string; updated: string }[]>,
    cli: (args: string[], cwd?: string) => ipcRenderer.invoke('slash:cli', args, cwd) as Promise<string>
  },
  chat: {
    send: (payload: {
      tabId: string
      text: string
      kind: AiKind
      cwd?: string
      sessionId?: string
      model?: string
      effort?: string
      agentMode?: string
      alwaysApprove?: boolean
      history?: { who: 'brain' | 'me'; text: string }[]
      system?: string
      attachments?: { path: string; name: string; mime: string }[]
    }) => ipcRenderer.invoke('chat:send', payload),
    onEvent: (
      cb: (ev: {
        tabId: string
        kind: 'thought' | 'text' | 'file' | 'status' | 'context' | 'commands' | 'done' | 'error'
        data?: string
        path?: string
        tool?: string
        used?: number
        total?: number
        percent?: number
        commands?: { name: string; description: string; hint?: string }[]
      }) => void
    ) => {
      const handler = (_: unknown, ev: Parameters<typeof cb>[0]) => cb(ev)
      ipcRenderer.on('chat:event', handler)
      return () => {
        ipcRenderer.removeListener('chat:event', handler)
      }
    },
    stop: (tabId: string) => ipcRenderer.invoke('chat:stop', tabId),
    resume: (payload: { tabId: string; kind: AiKind; cwd?: string; sessionId: string }) =>
      ipcRenderer.invoke('chat:resume', payload) as Promise<{
        ok: boolean
        error?: string
        sessionId?: string
        messages?: { who: 'me' | 'brain'; text: string }[]
      }>,
    fork: (payload: { tabId: string; kind: AiKind; cwd?: string }) =>
      ipcRenderer.invoke('chat:fork', payload) as Promise<{ ok: boolean; error?: string; sessionId?: string }>,
    warm: (payload: {
      tabId: string
      kind: AiKind
      cwd?: string
      model?: string
      effort?: string
      agentMode?: string
      resumeId?: string
    }) =>
      ipcRenderer.invoke('chat:warm', payload) as Promise<{
        ok: boolean
        model?: string
        effort?: string
        agentMode?: string
        sessionId?: string
        contextTotal?: number
        models?: { id: string; label: string }[]
        efforts?: { id: string; label: string }[]
        agentModes?: { id: string; label: string }[]
        commands?: { name: string; description: string; hint?: string }[]
      }>,
    reset: (payload: {
      tabId: string
      kind: AiKind
      cwd?: string
      model?: string
      effort?: string
    }) => ipcRenderer.invoke('chat:reset', payload),
    close: (tabId: string) => ipcRenderer.invoke('chat:close', tabId),
    loadState: (cwd?: string) => ipcRenderer.invoke('chat:loadState', cwd),
    onWillQuit: (cb: () => void) => {
      const handler = () => cb()
      ipcRenderer.on('app:will-quit', handler)
      return () => {
        ipcRenderer.removeListener('app:will-quit', handler)
      }
    },
    saveState: (state: {
      cwd: string
      active: string
      tabs: Record<string, unknown>[]
      messages: Record<string, { who: string; text: string }[]>
    }) => ipcRenderer.invoke('chat:saveState', state),
    saveStateSync: (state: {
      cwd: string
      active: string
      tabs: Record<string, unknown>[]
      messages: Record<string, { who: string; text: string }[]>
    }) => ipcRenderer.sendSync('chat:saveStateSync', state) as boolean,
    flushDone: () => ipcRenderer.send('app:flush-done'),
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
