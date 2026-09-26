import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { AiKind } from '../shared/contracts'

type PhoneRemoteStatus = {
  on: boolean
  url: string
  origin: string
  detail: string
  platform: string
  watching: boolean
  pairPin: string
  pairQr: string
  pairUntil: number
  devices: { id: string; label: string; lastSeen: number }[]
}

const brain = {
  quit: () => ipcRenderer.invoke('app:quit'),
  version: () => ipcRenderer.invoke('app:version') as Promise<string>,
  checkUpdate: () =>
    ipcRenderer.invoke('app:checkUpdate') as Promise<{ ok: boolean; detail?: string; version?: string }>,
  installUpdate: () => ipcRenderer.invoke('app:installUpdate') as Promise<{ ok: boolean }>,
  onUpdate: (fn: (ev: { status: string; detail: string }) => void) => {
    const h = (_e: unknown, payload: { status: string; detail: string }) => fn(payload)
    ipcRenderer.on('app:update', h)
    return () => {
      ipcRenderer.removeListener('app:update', h)
    }
  },
  onSyncHealth: (fn: (ev: { ok: boolean; line: string; lastSync: string; offline: boolean; error: string }) => void) => {
    const h = (_e: unknown, payload: { ok: boolean; line: string; lastSync: string; offline: boolean; error: string }) =>
      fn(payload)
    ipcRenderer.on('sync:health', h)
    return () => {
      ipcRenderer.removeListener('sync:health', h)
    }
  },
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
      justUpdated: { from: string; to: string } | null
      projectSeat: { folder: string; label: string; lastSync: string } | null
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
        name?: string
        role?: string
        signedIn?: boolean
        watching: boolean
        brainPath: string | null
        brainName: string | null
        brainSlug: string | null
        plyntrBrain: boolean
        source?: string
      }>,
    setSuper: (on: boolean) => ipcRenderer.invoke('settings:setSuper', on),
    roster: () =>
      ipcRenderer.invoke('settings:roster') as Promise<
        {
          name: string
          email: string
          role: 'owner' | 'scout' | 'team' | 'project'
          brain: string
          brains?: string[]
        }[]
      >,
    rosterAt: (folder: string) =>
      ipcRenderer.invoke('settings:rosterAt', folder) as Promise<
        {
          name: string
          email: string
          role: 'owner' | 'scout' | 'team' | 'project'
          brain: string
          brains?: string[]
        }[]
      >,
    team: () =>
      ipcRenderer.invoke('settings:team') as Promise<
        {
          name: string
          email: string
          role: 'owner' | 'scout' | 'team' | 'project'
          brain: string
          client?: string
          brains?: string[]
        }[]
      >,
    saveTeam: (
      people: {
        name: string
        email: string
        role: 'owner' | 'scout' | 'team' | 'project'
        brain: string
        client?: string
        brains?: string[]
      }[]
    ) => ipcRenderer.invoke('settings:saveTeam', people),
    projects: () =>
      ipcRenderer.invoke('settings:projects') as Promise<{ id: string; name: string }[]>,
    addTeammate: (person: {
      name: string
      email: string
      role: 'owner' | 'scout' | 'team' | 'project'
      brain?: string
      client?: string
      brains?: string[]
    }) =>
      ipcRenderer.invoke('settings:addTeammate', person) as Promise<{
        people: unknown[]
        roster: { ok: boolean; detail: string }
      }>,
    clients: () => ipcRenderer.invoke('settings:clients') as Promise<Record<string, unknown>[]>,
    saveClients: (clients: unknown[]) => ipcRenderer.invoke('settings:saveClients', clients)
  },
  shellView: () =>
    ipcRenderer.invoke('shell:view') as Promise<{
      email: string
      flag: boolean
      signedIn: string[]
      keyless: string[]
      seat: { email?: string; label?: string; token?: string }
    }>,
  brains: {
    list: () =>
      ipcRenderer.invoke('brains:list') as Promise<
        {
          path: string
          name: string
          slug: string
          role?: string
          watching?: boolean
          current?: boolean
          syncMode?: 'plyntr' | 'agency-brain' | 'local'
          brainId?: string
        }[]
      >,
    switch: (folder: string) =>
      ipcRenderer.invoke('brains:switch', folder) as Promise<{
        path: string
        name: string
        slug: string
        agency?: { ok: boolean; detail: string }
        hq?: { ok: boolean; detail: string }
      }>,
    add: (opts: { code: string }) =>
      ipcRenderer.invoke('brains:add', opts) as Promise<{
        ok?: boolean
        skipped?: boolean
        detail?: string
        slug?: string
        name?: string
        setup?: boolean
        already?: boolean
        brainPath?: string
        agency?: { ok: boolean; detail: string }
        hq?: { ok: boolean; detail: string }
      }>,
    remember: (row: { path?: string; name?: string; slug?: string; role?: string }) =>
      ipcRenderer.invoke('brains:remember', row)
  },
  auth: {
    resolveCode: (code: string) => ipcRenderer.invoke('auth:resolveCode', code),
    requestCode: (email: string, via?: 'ads2ai' | 'hq-sync') =>
      ipcRenderer.invoke('auth:requestCode', email, via) as Promise<{ ok: boolean; via: 'ads2ai' | 'hq-sync' }>,
    verify: (email: string, code: string, via?: 'ads2ai' | 'hq-sync') =>
      ipcRenderer.invoke('auth:verify', email, code, via) as Promise<{
        ok: boolean
        via: 'ads2ai' | 'hq-sync' | 'plyntr'
        member: { email: string; name?: string; role?: string }
        teams: { slug: string; name: string; role: string; kind?: string }[]
        brainPath?: string
        teamName?: string
        role?: string
        brainId?: string
        repo?: string
        slug?: string
      }>,
    session: () =>
      ipcRenderer.invoke('auth:session') as Promise<{
        signedIn: boolean
        email: string
        name: string
        role?: string
        folder?: string
        source?: string
      }>,
    logout: () => ipcRenderer.invoke('auth:logout') as Promise<{ ok: boolean }>,
    joinFolder: (email: string, folder?: string) =>
      ipcRenderer.invoke('auth:joinFolder', email, folder) as Promise<{
        ok: boolean
        email: string
        name: string
        role: string
        brainPath: string
        teamName: string
        teamSlug: string
      }>,
    myTeams: () => ipcRenderer.invoke('auth:myTeams')
  },
  hqSync: {
    requestCode: (email: string) => ipcRenderer.invoke('hqSync:requestCode', email) as Promise<{ ok: boolean }>,
    join: (opts: { email: string; code: string; folder?: string }) =>
      ipcRenderer.invoke('hqSync:join', opts) as Promise<{
        ok: boolean
        email: string
        name: string
        role: string
        brainPath: string
        teamName: string
        teamSlug: string
        roots: string[]
      }>,
    openExisting: () =>
      ipcRenderer.invoke('hqSync:openExisting') as Promise<{
        ok: boolean
        email: string
        name: string
        role: string
        brainPath: string
        teamName: string
        teamSlug: string
        roots: string[]
      }>,
    ownerRequestCode: (email: string) =>
      ipcRenderer.invoke('hqSync:ownerRequestCode', email) as Promise<{ ok: boolean }>,
    ownerLogin: (opts: { email: string; code: string }) =>
      ipcRenderer.invoke('hqSync:ownerLogin', opts) as Promise<{
        ok: boolean
        email: string
        kind: string
        hq_repo: string
        brain_label: string
      }>,
    ownerStatus: () =>
      ipcRenderer.invoke('hqSync:ownerStatus') as Promise<{
        signedIn: boolean
        email: string
        kind: string
        hq_repo: string
        brain_label: string
        projects: { slug: string; path: string }[]
        seats: { seat_id: string; email: string; name: string; status: string; roots: string[]; kind: string }[]
        businesses: { id: string; name: string; hq_repo: string; owners: { email: string; name: string; role: string }[] }[]
      }>,
    addCompany: (opts: { name: string; email: string; owner_name: string; role?: string }) =>
      ipcRenderer.invoke('hqSync:addCompany', opts) as Promise<{
        ok: true
        business: { id: string; name: string; hq_repo: string; owners: { email: string; name: string; role: string }[] }
        detail: string
      }>,
    watchedRepo: () => ipcRenderer.invoke('hqSync:watchedRepo') as Promise<string>,
    bind: (hqRepo: string) =>
      ipcRenderer.invoke('hqSync:bind', hqRepo) as Promise<{
        ok: boolean
        hq_repo?: string
        install_url?: string
        detail: string
        projects?: string[]
      }>,
    health: () =>
      ipcRenderer.invoke('hqSync:health') as Promise<{
        ok: boolean
        line: string
        lastSync: string
        offline: boolean
        error: string
      }>,
    revoke: (seatId: string) =>
      ipcRenderer.invoke('hqSync:revoke', seatId) as Promise<{ ok: boolean; detail: string }>
  },
  setup: {
    createTeam: (name: string) => ipcRenderer.invoke('setup:createTeam', name),
    lookupOrg: (login: string) =>
      ipcRenderer.invoke('setup:lookupOrg', login) as Promise<{
        ok: boolean
        reason?: string
        detail?: string
        login?: string
        type?: string
        id?: number
      }>,
    adviseOrg: (login: string) =>
      ipcRenderer.invoke('setup:adviseOrg', login) as Promise<{
        preferred: string
        free: boolean
        takenType: string
        suggestion: string
      }>,
    openCreateOrg: () =>
      ipcRenderer.invoke('setup:openCreateOrg') as Promise<{ ok: boolean; org?: string }>,
    openAppInstall: (slug: string, org?: string) =>
      ipcRenderer.invoke('setup:openAppInstall', slug, org),
    pollInstall: (slug: string) => ipcRenderer.invoke('setup:pollInstall', slug),
    waitInstall: (slug: string) =>
      ipcRenderer.invoke('setup:waitInstall', slug) as Promise<{
        ok: boolean
        installed?: boolean
        repoUrl?: string
        detail?: string
      }>,
    bringFront: () => ipcRenderer.invoke('setup:bringFront'),
    clipOrg: () => ipcRenderer.invoke('setup:clipOrg') as Promise<{ ok: boolean; org?: string }>,
    onBack: (fn: (ev: { org?: string }) => void) => {
      const h = (_e: unknown, payload: { org?: string }) => fn(payload || {})
      ipcRenderer.on('setup:back', h)
      return () => {
        ipcRenderer.removeListener('setup:back', h)
      }
    },
    bridgeStatus: (folder: string) =>
      ipcRenderer.invoke('setup:bridgeStatus', folder) as Promise<{
        ok: boolean
        installed: boolean
        skipped?: boolean
        repo: string
        detail?: string
      }>,
    openBridge: (folder: string) =>
      ipcRenderer.invoke('setup:openBridge', folder) as Promise<{ ok: boolean; repo: string }>,
    openBridgeRepo: (repo: string) =>
      ipcRenderer.invoke('setup:openBridgeRepo', repo) as Promise<{
        ok: boolean
        repo: string
        url: string
        detail?: string
      }>,
    bridgeOnRepo: (repo: string) =>
      ipcRenderer.invoke('setup:bridgeOnRepo', repo) as Promise<{
        ok: boolean
        installed: boolean
        skipped?: boolean
        repositorySelection?: string
        repo: string
        detail?: string
      }>,
    waitBridge: (folder: string) =>
      ipcRenderer.invoke('setup:waitBridge', folder) as Promise<{
        ok: boolean
        installed: boolean
        skipped?: boolean
        repo?: string
        detail?: string
      }>,
    ensureRepo: (slug: string) => ipcRenderer.invoke('setup:ensureRepo', slug),
    putFolder: (opts: { teamSlug: string; org?: string; retry?: boolean }) =>
      ipcRenderer.invoke('setup:putFolder', opts) as Promise<{
        ok: boolean
        brainPath?: string | null
        skipped?: boolean
        reason?: string
        detail?: string
      }>,
    putFolderPlyntr: (opts: { brainId: string; org?: string; slug?: string; repo?: string }) =>
      ipcRenderer.invoke('setup:putFolderPlyntr', opts) as Promise<{ ok: boolean; brainPath?: string }>,
    putFolderLocal: (opts: {
      brainId: string
      org?: string
      slug?: string
      repo?: string
      email?: string
      name?: string
    }) =>
      ipcRenderer.invoke('setup:putFolderLocal', opts) as Promise<{ ok: boolean; brainPath?: string; seeded?: boolean }>,
    tryOpen: (kind: AiKind, folder?: string) =>
      ipcRenderer.invoke('setup:tryOpen', kind, folder) as Promise<{
        opened: boolean
        signedIn: boolean
        git: boolean
        model: string
        effort: string
        detail: string
      }>,
    onExplain: (fn: (text: string, token?: number) => void) => {
      const h = (_e: unknown, payload: string | { text?: string; token?: number }) => {
        if (typeof payload === 'string') fn(payload)
        else fn(String(payload?.text || ''), payload?.token)
      }
      ipcRenderer.on('setup:explain-text', h)
      return () => {
        ipcRenderer.removeListener('setup:explain-text', h)
      }
    },
    explain: (body: { heading: string; kinds: AiKind[]; strip?: boolean; cwd?: string; token?: number }) =>
      ipcRenderer.invoke('setup:explain', body) as Promise<{ ok: boolean; cwd: string }>,
    ensureDraft: (id: string) =>
      ipcRenderer.invoke('setup:ensureDraft', id) as Promise<{ ok: boolean; path: string; sync: boolean; remote: boolean }>,
    mergeDraft: (draft: string, clone: string) =>
      ipcRenderer.invoke('setup:mergeDraft', draft, clone) as Promise<{ copied: string[]; left: string[] }>,
    enableLocalSync: (opts: { folder?: string; org?: string; repo?: string }) =>
      ipcRenderer.invoke('setup:enableLocalSync', opts) as Promise<{ ok: boolean; detail: string; repo: string }>,
    syncMode: (folder: string) => ipcRenderer.invoke('setup:syncMode', folder) as Promise<string>,
    openPlyntrInstall: (brainId: string, org?: string, repo?: string) =>
      ipcRenderer.invoke('setup:openPlyntrInstall', brainId, org, repo) as Promise<{
        ok: boolean
        url: string
        detail?: string
      }>,
    createPlyntrRepo: (org: string, slug: string, repo?: string) =>
      ipcRenderer.invoke('setup:createPlyntrRepo', org, slug, repo) as Promise<{
        ok: boolean
        repo: string
        detail?: string
      }>,
    openPlyntrRepo: (org: string, slug: string) =>
      ipcRenderer.invoke('setup:openPlyntrRepo', org, slug) as Promise<{ ok: boolean; url: string }>,
    applyFolder: (opts?: { teamSlug?: string; dest?: string }) =>
      ipcRenderer.invoke('setup:applyFolder', opts) as Promise<{
        ok: boolean
        brainPath?: string | null
        skipped?: boolean
        reason?: string
        detail?: string
      }>,
    status: (kind?: AiKind) =>
      ipcRenderer.invoke('setup:status', kind) as Promise<{
        ready: boolean
        watching: boolean
        brainPath?: string | null
        items: {
          id: string
          label: string
          line: string
          present: boolean
          warn: string
          accept: string
          kind?: 'status' | 'install'
        }[]
      }>,
    install: (id: string) =>
      ipcRenderer.invoke('setup:install', id) as Promise<{
        ok: boolean
        detail: string
        wait: 'none' | 'present' | 'watching'
      }>
  },
  plyntr: {
    pending: () =>
      ipcRenderer.invoke('plyntr:pending') as Promise<{
        platform: boolean
        create: {
          createId: string
          wizardStep: number
          label: string
          org: string
          slug: string
          scoutEmail: string
          brainId?: string
        } | null
        join: {
          brainId: string
          repo: string
          role: string
          email: string
          name: string
          slug: string
          label: string
          wizardStep: number
        } | null
      }>,
    saveCreate: (row: {
      createId?: string
      wizardStep?: number
      label?: string
      org?: string
      slug?: string
      scoutEmail?: string
      brainId?: string
    }) => ipcRenderer.invoke('plyntr:saveCreate', row) as Promise<{ ok: boolean }>,
    clearCreate: () => ipcRenderer.invoke('plyntr:clearCreate') as Promise<{ ok: boolean }>,
    clearJoin: () => ipcRenderer.invoke('plyntr:clearJoin') as Promise<{ ok: boolean }>,
    hasSeat: (brainId: string) => ipcRenderer.invoke('plyntr:hasSeat', brainId) as Promise<boolean>,
    resumeAccount: (which: 'create' | 'join') =>
      ipcRenderer.invoke('plyntr:resumeAccount', which) as Promise<{ ok: boolean; email: string; role: string }>,
    createBrain: (body: { label: string; org: string; slug: string; scoutEmail: string; rotate?: boolean }) =>
      ipcRenderer.invoke('plyntr:createBrain', body) as Promise<{
        brainId: string
        repo: string
        slug: string
        label: string
        email: string
        code: string
        emailed: boolean
        role: string
        hasToken: boolean
      }>,
    companies: () =>
      ipcRenderer.invoke('plyntr:companies') as Promise<
        { brainId: string; label: string; slug: string; org: string; repo: string; createdAt: string; pack?: string }[]
      >,
    setPack: (brainId: string, pack: string) =>
      ipcRenderer.invoke('plyntr:setPack', brainId, pack) as Promise<{ brainId: string; pack: string }>,
    company: (brainId: string) =>
      ipcRenderer.invoke('plyntr:company', brainId) as Promise<{
        brainId: string
        label: string
        slug: string
        org: string
        repo: string
        seats: { id: string; email: string; name: string; role: string; status: string; bootstrap?: boolean }[]
        invites: { inviteId: string; email: string; name: string; role: string; status: string }[]
        pack?: string
      }>,
    companyInvite: (brainId: string, body: { email: string; name: string; role: string; roots?: string[] }) =>
      ipcRenderer.invoke('plyntr:companyInvite', brainId, body) as Promise<{
        code: string
        emailed: boolean
        pendingFolders: boolean
      }>,
    claimCompany: (brainId: string) =>
      ipcRenderer.invoke('plyntr:claimCompany', brainId) as Promise<{
        brainId: string
        repo: string
        slug: string
        label: string
        email: string
        role: string
        code: string
        bootstrap: boolean
        hasToken: boolean
      }>,
    openCompany: (body: { label: string; ownerName: string; ownerEmail: string; role?: string; pack?: string }) =>
      ipcRenderer.invoke('plyntr:openCompany', body) as Promise<{
        brainId: string
        repo: string
        slug: string
        label: string
        code: string
        emailed: boolean
        ownerEmail: string
        ownerName: string
        role: string
        hasToken: boolean
      }>,
    emailCode: (email: string) =>
      ipcRenderer.invoke('plyntr:emailCode', email) as Promise<{ ok: boolean; emailed: boolean; role: string }>,
    place: (body: { brainId: string; org: string }) =>
      ipcRenderer.invoke('plyntr:place', body) as Promise<{ repo: string; slug: string; org: string }>,
    resolve: (code: string, typedEmail?: string) =>
      ipcRenderer.invoke('plyntr:resolve', code, typedEmail || '') as Promise<{
        brainId: string
        repo: string
        role: string
        email: string
        name: string
        label: string
        slug: string
        bootstrap: boolean
        hasToken: boolean
      }>,
    joinProject: (code: string) =>
      ipcRenderer.invoke('plyntr:joinProject', code) as Promise<{
        ok: boolean
        email: string
        name: string
        role: 'project'
        brainPath: string
        teamName: string
        teamSlug: string
        roots: string[]
      }>,
    installed: (brainId: string, repo: string) =>
      ipcRenderer.invoke('plyntr:installed', brainId, repo) as Promise<{
        ready: boolean
        installed: boolean
        repo: string
        repositorySelection: string
        projectSeatCount: number
      }>,
    seats: (brainId: string) =>
      ipcRenderer.invoke('plyntr:seats', brainId) as Promise<{
        seats: {
          id: string
          email: string
          name: string
          role: string
          status: string
          bootstrap?: boolean
          plyntrScout?: boolean
          roots?: string[]
        }[]
        invites: { inviteId: string; email: string; name: string; role: string; status: string; expiresAt: string; roots?: string[] }[]
        pack?: string
      }>,
    bind: (brainId: string) =>
      ipcRenderer.invoke('plyntr:bind', brainId) as Promise<{
        ok: boolean
        hq_repo?: string
        install_url?: string
        detail: string
        projects?: string[]
      }>,
    invite: (brainId: string, body: { email: string; name: string; role: string; roots?: string[] }) =>
      ipcRenderer.invoke('plyntr:invite', brainId, body) as Promise<{
        inviteId: string
        code: string
        expiresAt: string
        emailed?: boolean
        needsBridge?: boolean
        projectSeatCount?: number
      }>,
    transfer: (brainId: string) =>
      ipcRenderer.invoke('plyntr:transfer', brainId) as Promise<{ ok: boolean; removed?: boolean; email?: string }>,
    revokeSeat: (brainId: string, seatId: string) =>
      ipcRenderer.invoke('plyntr:revokeSeat', brainId, seatId) as Promise<{ ok: boolean }>,
    revokeInvite: (brainId: string, inviteId: string) =>
      ipcRenderer.invoke('plyntr:revokeInvite', brainId, inviteId) as Promise<{ ok: boolean }>,
    active: () =>
      ipcRenderer.invoke('plyntr:active') as Promise<{
        folder: string
        syncMode: string
        brainId: string
        role: string
        accountRole: string
        seatEmail: string
        hasSeat: boolean
        org: string
        slug: string
        label: string
        scoutEmail: string
        canMove: boolean
      }>,
    move: () =>
      ipcRenderer.invoke('plyntr:move') as Promise<{
        ok: boolean
        detail: string
        needInstall: boolean
        startedSync: boolean
        wroteManifest: boolean
        brainId: string
      }>
  },
  ab: {
    detect: () => ipcRenderer.invoke('ab:detect'),
    install: () => ipcRenderer.invoke('ab:install'),
    watching: () => ipcRenderer.invoke('ab:watching')
  },
  ai: {
    detect: () => ipcRenderer.invoke('ai:detect'),
    login: (which: AiKind) => ipcRenderer.invoke('ai:login', which),
    loginWait: (which: AiKind) =>
      ipcRenderer.invoke('ai:loginWait', which) as Promise<{ ok: boolean; detail: string; signedIn?: boolean }>,
    signedIn: (which: AiKind) =>
      ipcRenderer.invoke('ai:signedIn', which) as Promise<{ ok: boolean; signedIn: boolean }>
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
    write: (root: string, abs: string, text: string) =>
      ipcRenderer.invoke('files:write', root, abs, text) as Promise<{ ok: true }>,
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
    usage: (cwd?: string, kind?: string, sessionId?: string) =>
      ipcRenderer.invoke('slash:usage', cwd, kind, sessionId) as Promise<string>,
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
        kind: string
        data?: string
        path?: string
        tool?: string
        used?: number
        total?: number
        percent?: number
        commands?: { name: string; description: string; hint?: string }[]
        title?: string
        options?: { id: string; label: string }[]
        requestId?: string
        steps?: { title: string; status?: string }[]
        fingerprint?: string
        skinLabel?: string | null
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
    }) =>
      ipcRenderer.invoke('chat:reset', payload) as Promise<{
        ok: boolean
        sessionId?: string
        model?: string
        effort?: string
      }>,
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
    needs: () => ipcRenderer.invoke('chat:needs'),
    firstWelcome: (cwd?: string) =>
      ipcRenderer.invoke('chat:firstWelcome', cwd) as Promise<{ show: boolean; text: string }>
  },
  skin: {
    get: () =>
      ipcRenderer.invoke('skin:get') as Promise<{
        capture: boolean
        jev: boolean
        jevReady: boolean
        joe: boolean
        components: string[]
        learned: { cli: string; eventKind: string; component: string; confidence: number }[]
      }>,
    toggle: (on: boolean) => ipcRenderer.invoke('skin:toggle', on) as Promise<{ ok: boolean; capture: boolean }>,
    toggleJev: (on: boolean) =>
      ipcRenderer.invoke('skin:toggleJev', on) as Promise<{ ok: boolean; jev: boolean; jevReady: boolean }>,
    list: () =>
      ipcRenderer.invoke('skin:list') as Promise<
        {
          id: string
          at: string
          cli: string
          eventKind: string
          fingerprint: string
          catalogId: string | null
          matched: boolean
          learned?: boolean
          label: string | null
          propsHint: Record<string, unknown>
          jevProposal: {
            component: string | null
            confidence: number
            paint: boolean
            detail: string
          } | null
        }[]
      >,
    label: (fingerprint: string, label: string) =>
      ipcRenderer.invoke('skin:label', fingerprint, label) as Promise<{ ok: boolean }>,
    propose: (fingerprint: string) =>
      ipcRenderer.invoke('skin:propose', fingerprint) as Promise<{
        ok: boolean
        detail?: string
        proposal?: { component: string | null; confidence: number; paint: boolean; detail: string }
      }>,
    learn: () =>
      ipcRenderer.invoke('skin:learn') as Promise<{
        ok: boolean
        added: number
        detail?: string
        learned?: { cli: string; eventKind: string; component: string; confidence: number }[]
      }>,
    decide: (tabId: string, optionId: string) =>
      ipcRenderer.invoke('skin:decide', { tabId, optionId }) as Promise<{ ok: boolean }>,
    onHealed: (
      fn: (ev: { fingerprint: string; cli: string; eventKind: string; component: string }) => void
    ) => {
      const h = (_e: unknown, payload: { fingerprint: string; cli: string; eventKind: string; component: string }) =>
        fn(payload)
      ipcRenderer.on('skin:healed', h)
      return () => {
        ipcRenderer.removeListener('skin:healed', h)
      }
    }
  },
  phone: {
    start: () => ipcRenderer.invoke('phone:start') as Promise<PhoneRemoteStatus>,
    stop: () => ipcRenderer.invoke('phone:stop') as Promise<PhoneRemoteStatus>,
    status: () => ipcRenderer.invoke('phone:status') as Promise<PhoneRemoteStatus>,
    rotate: () => ipcRenderer.invoke('phone:rotate') as Promise<PhoneRemoteStatus>,
    link: () => ipcRenderer.invoke('phone:link') as Promise<PhoneRemoteStatus>,
    unlink: (id: string) => ipcRenderer.invoke('phone:unlink', id) as Promise<PhoneRemoteStatus>,
    copy: () => ipcRenderer.invoke('phone:copy') as Promise<{ ok: boolean }>,
    onStatus: (fn: (ev: PhoneRemoteStatus) => void) => {
      const h = (_e: unknown, payload: PhoneRemoteStatus) => fn(payload)
      ipcRenderer.on('phone:status', h)
      return () => {
        ipcRenderer.removeListener('phone:status', h)
      }
    },
    onIncoming: (fn: (ev: {
      tabId: string
      text: string
      files?: { path: string; name: string; mime: string }[]
      queued?: boolean
      queueId?: string
    }) => void) => {
      const h = (
        _e: unknown,
        payload: {
          tabId: string
          text: string
          files?: { path: string; name: string; mime: string }[]
          queued?: boolean
          queueId?: string
        }
      ) => fn(payload)
      ipcRenderer.on('phone:incoming', h)
      return () => {
        ipcRenderer.removeListener('phone:incoming', h)
      }
    },
    onTab: (fn: (ev: { op: 'new' | 'close'; id: string; kind?: string }) => void) => {
      const h = (_e: unknown, payload: { op: 'new' | 'close'; id: string; kind?: string }) => fn(payload)
      ipcRenderer.on('phone:tab', h)
      return () => {
        ipcRenderer.removeListener('phone:tab', h)
      }
    },
    onStop: (fn: (ev: { tabId: string }) => void) => {
      const h = (_e: unknown, payload: { tabId: string }) => fn(payload)
      ipcRenderer.on('phone:stop', h)
      return () => {
        ipcRenderer.removeListener('phone:stop', h)
      }
    },
    onQueue: (fn: (ev: { op: 'drop' | 'now'; tabId: string; id: string }) => void) => {
      const h = (_e: unknown, payload: { op: 'drop' | 'now'; tabId: string; id: string }) => fn(payload)
      ipcRenderer.on('phone:queue', h)
      return () => {
        ipcRenderer.removeListener('phone:queue', h)
      }
    },
    reportQueue: (
      tabId: string,
      items: { id: string; text: string; names: string[]; files?: { path: string; name: string; mime: string }[] }[]
    ) => {
      ipcRenderer.send('phone:reportQueue', tabId, items)
    }
  }
}

contextBridge.exposeInMainWorld('brain', brain)

export type BrainApi = typeof brain

declare global {
  interface Window {
    brain: BrainApi
  }
}
