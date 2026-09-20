import { chmodSync, existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { plyntrOwnerEmail } from './agency-brain'
import { SUPERADMIN_EMAIL } from './super-admin'

export type Account = {
  email: string
  appEmail?: string
  name?: string
  token: string
  role?: string
  source?: 'ads2ai' | 'team-file' | 'hq-sync'
  folder?: string
  brains?: string[]
}

let memberToken: string | null = null
let account: Account | null = null

function accountPath(): string {
  return join(app.getPath('userData'), 'account.json')
}

function persist(next: Account | null): void {
  const p = accountPath()
  if (!next) {
    memberToken = null
    account = null
    if (existsSync(p)) unlinkSync(p)
    return
  }
  account = next
  memberToken = next.token
  writeFileSync(
    p,
    JSON.stringify({
      email: next.email,
      appEmail: next.appEmail || next.email || '',
      name: next.name || '',
      token: next.token,
      role: next.role || '',
      source: next.source || 'ads2ai',
      folder: next.folder || '',
      brains: next.brains || []
    })
  )
  try {
    chmodSync(p, 0o600)
  } catch {
    /* windows */
  }
}

export function loadAccount(): Account | null {
  if (account) return account
  try {
    const raw = JSON.parse(readFileSync(accountPath(), 'utf8')) as Account
    const email = String(raw.email || '').trim().toLowerCase()
    const token = String(raw.token || '')
    if (!email || !token) return null
    let appEmail = String(raw.appEmail || '').trim().toLowerCase()
    if (!appEmail && email === SUPERADMIN_EMAIL) appEmail = email
    if (!appEmail) {
      const hint = plyntrOwnerEmail()
      if (hint === SUPERADMIN_EMAIL) appEmail = hint
    }
    if (!appEmail) appEmail = email
    account = {
      email: appEmail === SUPERADMIN_EMAIL ? appEmail : email,
      appEmail,
      name: String(raw.name || ''),
      token,
      role: String(raw.role || ''),
      source: raw.source === 'team-file' ? 'team-file' : raw.source === 'hq-sync' ? 'hq-sync' : 'ads2ai',
      folder: String(raw.folder || ''),
      brains: Array.isArray(raw.brains) ? raw.brains.map((b) => String(b || '').trim()).filter(Boolean) : []
    }
    memberToken = token
    if (appEmail === SUPERADMIN_EMAIL && email !== SUPERADMIN_EMAIL) persist(account)
    return account
  } catch {
    return null
  }
}

export function saveAccount(next: Account): Account {
  const email = String(next.email || '').trim().toLowerCase()
  const appEmail = String(next.appEmail || email).trim().toLowerCase()
  persist({
    email: appEmail === SUPERADMIN_EMAIL ? appEmail : email,
    appEmail,
    name: String(next.name || ''),
    token: String(next.token || ''),
    role: String(next.role || ''),
    source: next.source === 'team-file' ? 'team-file' : next.source === 'hq-sync' ? 'hq-sync' : 'ads2ai',
    folder: String(next.folder || ''),
    brains: Array.isArray(next.brains) ? next.brains.map((b) => String(b || '').trim()).filter(Boolean) : []
  })
  return account as Account
}

/** Clears Brain.app sign-in only. Does not delete chats, Settings lists, or Agency Brain folders. */
export function clearAccount(): void {
  persist(null)
}

export function setMemberToken(token: string | null): void {
  memberToken = token
  if (!token && account) persist(null)
}

export function getMemberToken(): string {
  if (!memberToken) loadAccount()
  if (!memberToken) throw new Error('Sign in first')
  if (memberToken.startsWith('local:') || account?.source === 'hq-sync') {
    throw new Error('This sign-in is the shared folder, not Agency Brain membership.')
  }
  return memberToken
}

export function getAccount(): Account | null {
  return account || loadAccount()
}
