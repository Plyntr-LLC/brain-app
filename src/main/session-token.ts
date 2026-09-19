import { chmodSync, existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

export type Account = {
  email: string
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
    account = {
      email,
      name: String(raw.name || ''),
      token,
      role: String(raw.role || ''),
      source: raw.source === 'team-file' ? 'team-file' : raw.source === 'hq-sync' ? 'hq-sync' : 'ads2ai',
      folder: String(raw.folder || ''),
      brains: Array.isArray(raw.brains) ? raw.brains.map((b) => String(b || '').trim()).filter(Boolean) : []
    }
    memberToken = token
    return account
  } catch {
    return null
  }
}

export function saveAccount(next: Account): Account {
  persist({
    email: String(next.email || '').trim().toLowerCase(),
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
