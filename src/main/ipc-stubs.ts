import { ipcMain, shell } from 'electron'
import { DOWNLOAD_AB, GITHUB_APP_INSTALL, GITHUB_NEW_ORG } from '../shared/contracts'
import * as ads2ai from './ads2ai'
import { getMemberToken, setMemberToken } from './session-token'

export function dryRun(): boolean {
  return process.env.BRAIN_APP_DRY_RUN !== '0'
}

export function registerStubIpc(): void {
  ipcMain.handle('env:get', () => ({ dryRun: dryRun() }))

  ipcMain.handle('auth:resolveCode', async (_e, raw: string) => {
    const code = String(raw || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase()
    if (dryRun()) {
      setMemberToken('dry-run')
      return {
        dryRun: true,
        teamSlug: 'harolds-books',
        teamName: "Harold's Books",
        kind: 'client',
        repoUrl: '',
        member: { email: 'harold@example.com', name: 'Harold', role: 'owner' }
      }
    }
    const res = await ads2ai.resolveInvite(code)
    setMemberToken(res.memberToken)
    const m = res.member || {}
    return {
      teamSlug: res.teamSlug,
      teamName: res.teamName || res.teamSlug,
      kind: res.kind || 'agency',
      repoUrl: res.repoUrl || '',
      member: {
        email: String(m.email || res.memberEmail || '').toLowerCase(),
        name: m.name || res.memberName || '',
        role: m.role || res.memberRole || 'team'
      }
    }
  })

  ipcMain.handle('auth:requestCode', async (_e, email: string) => {
    if (dryRun()) return { ok: true, dryRun: true, email }
    return ads2ai.requestCode(email)
  })
  ipcMain.handle('auth:verify', async (_e, email: string, code: string) => {
    if (dryRun()) {
      return {
        ok: true,
        dryRun: true,
        member: { email, name: 'You' },
        teams: []
      }
    }
    const res = await ads2ai.verifyCode(email, code)
    setMemberToken(res.token)
    const teams = (await ads2ai.myTeams(res.token)).teams || []
    return { ok: true, member: res.member, teams }
  })
  ipcMain.handle('auth:myTeams', async () => {
    if (dryRun()) return { teams: [] }
    return ads2ai.myTeams(getMemberToken())
  })

  ipcMain.handle('setup:createTeam', async (_e, name: string) => {
    if (dryRun()) return { dryRun: true, team: { slug: slugify(name), name, role: 'owner' } }
    throw new Error('setup:createTeam not wired')
  })
  ipcMain.handle('setup:lookupOrg', async (_e, login: string) => {
    if (dryRun()) return { ok: true, dryRun: true, login, type: 'Organization' }
    return ads2ai.lookupGithubAccount(login)
  })
  ipcMain.handle('setup:openCreateOrg', () => {
    shell.openExternal(GITHUB_NEW_ORG)
    return { ok: true }
  })
  ipcMain.handle('setup:openAppInstall', (_e, slug: string) => {
    const url = `${GITHUB_APP_INSTALL}?state=${encodeURIComponent(slug)}`
    shell.openExternal(url)
    return { ok: true, url }
  })
  ipcMain.handle('setup:pollInstall', async () => {
    if (dryRun()) return { installed: true, repoUrl: 'https://github.com/example/brain', dryRun: true }
    throw new Error('setup:pollInstall not wired')
  })
  ipcMain.handle('setup:ensureRepo', async () => {
    if (dryRun()) return { blocked: false, repoUrl: 'https://github.com/example/brain', dryRun: true }
    throw new Error('setup:ensureRepo not wired')
  })
  ipcMain.handle('setup:applyFolder', async () => {
    if (dryRun()) return { ok: true, dryRun: true, brainPath: '(dry-run, not written)' }
    throw new Error('setup:applyFolder not wired')
  })

  ipcMain.handle('ab:detect', async () => ({
    installed: true,
    path: '/Applications/Agency Brain.app'
  }))
  ipcMain.handle('ab:install', async () => {
    if (dryRun()) return { ok: true, dryRun: true, started: true }
    shell.openExternal(DOWNLOAD_AB)
    return { ok: true, openedDownload: true }
  })
  ipcMain.handle('ab:watching', async () => {
    if (dryRun()) return { watching: true, dryRun: true, brainPath: null, blocked: false }
    throw new Error('ab:watching not wired')
  })

  ipcMain.handle('ai:detect', async () => ({ claude: false, grok: false, gpt: false, dryRun: dryRun() }))
  ipcMain.handle('ai:login', async (_e, which: string) => ({ ok: true, which, dryRun: dryRun() }))

  ipcMain.handle('chat:send', async (_e, text: string) => ({
    reply: dryRun()
      ? `(dry-run) I heard you. The brain still needs a few things. ${text.slice(0, 80)}`
      : '',
    filled: {},
    done: false
  }))
  ipcMain.handle('chat:needs', async () => ({ filled: {}, remaining: [] }))
}

function slugify(s: string): string {
  return String(s || '')
    .toLowerCase()
    .trim()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 32) || 'brain'
}
