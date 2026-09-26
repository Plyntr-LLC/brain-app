import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { allowedFolders, isJoeSuperAdmin, openBrainAccountLabel, showAddCompany, showBrainSwitch, type SeatLabel, type ShellView } from '../shared/shell-switch.ts'

export type BrainRec = {
  id: string
  email: string
  role: string
  token: string
  owner: string
  slug?: string
  repo?: string
}

export type KeylessRec = {
  id: string
  label: string
}

type Disk = {
  shellEmail: string
  flag: boolean
  activeId: string
  brains: BrainRec[]
  keyless: KeylessRec[]
  onDisk: string[]
  folders: Record<string, string>
  slugs: Record<string, string>
}

const empty = (): Disk => ({
  shellEmail: '',
  flag: false,
  activeId: '',
  brains: [],
  keyless: [],
  onDisk: [],
  folders: {},
  slugs: {}
})

let root = ''
let memory: Disk | null = null
let folderToId: (folder: string) => string = () => ''

function file(): string {
  return join(root, 'vault.json')
}

export function vaultDir(): string {
  return root
}

export function initShellVault(dir: string): void {
  if (!dir || root === dir) return
  useRoot(dir)
}

export function useRoot(dir: string): void {
  root = dir
  mkdirSync(dir, { recursive: true })
  if (!existsSync(file())) writeFileSync(file(), JSON.stringify(empty()))
  memory = null
}

function readDisk(): Disk {
  if (!root || !existsSync(file())) return empty()
  return { ...empty(), ...JSON.parse(readFileSync(file(), 'utf8')) }
}

function current(): Disk {
  if (!memory) memory = readDisk()
  return memory
}

function save(next: Disk): void {
  memory = next
  if (root) writeFileSync(file(), JSON.stringify(next))
}

export function discardMemory(): void {
  memory = null
}

/** Main registers how a folder path maps to its brain id (brains.json, then sync.json slug). */
export function useFolderLookup(fn: (folder: string) => string): void {
  folderToId = fn
}

function idFor(row: Disk, idOrFolder: string): string {
  const key = String(idOrFolder || '').trim()
  if (!key) return ''
  if (row.folders[key]) return row.folders[key]
  let found = ''
  try {
    found = folderToId(key)
  } catch {
    found = ''
  }
  return found || key
}

export function shellEmail(): string {
  return current().shellEmail
}

export function setFlag(on: boolean): void {
  const row = current()
  if (row.flag === on) return
  save({ ...row, flag: on })
}

export function noteOnDisk(id: string): void {
  const row = current()
  if (row.onDisk.includes(id)) return
  save({ ...row, onDisk: [...row.onDisk, id] })
}

function owned(row: Disk, id: string): BrainRec | null {
  return row.brains.find((b) => b.id === id && b.owner === row.shellEmail) || null
}

export function acceptBrainCode(brainId: string, typedEmail: string, codeEmail: string, role: string, token: string, slug = '', repo = ''): string {
  const row = current()
  const typed = typedEmail.trim().toLowerCase()
  const shell = row.shellEmail || typed
  if (!token) {
    save({ ...row, shellEmail: row.shellEmail || typed })
    return (row.shellEmail || typed)
  }
  const existing = row.brains.find((b) => b.id === brainId)
  if (existing && existing.owner !== shell) {
    save({ ...row, shellEmail: shell })
    return shell
  }
  const next: BrainRec = {
    id: brainId,
    email: codeEmail,
    role,
    token,
    owner: shell,
    slug: slug || existing?.slug || '',
    repo: repo || existing?.repo || ''
  }
  const brains = existing ? row.brains.map((b) => (b.id === brainId ? next : b)) : [...row.brains, next]
  const slugs = { ...row.slugs }
  if (next.slug) slugs[next.slug.toLowerCase()] = brainId
  save({ ...row, shellEmail: shell, brains, slugs, activeId: brainId })
  return shell
}

export function resumeShellAccount(): string {
  return current().shellEmail
}

export function signInEmailOnly(email: string): string {
  const row = current()
  const want = email.trim().toLowerCase()
  let brains = row.brains
  let slugs = row.slugs
  const legacyPath = join(root, 'plyntr-seats.json')
  if (want === 'joe@plyntr.com' && brains.length === 0 && root && existsSync(legacyPath)) {
    const raw = readFileSync(legacyPath, 'utf8')
    if (raw.trim()) {
      const parsed = JSON.parse(raw) as {
        id?: string
        email?: string
        role?: string
        token?: string
        slug?: string
        repo?: string
        byBrain?: Record<string, { email?: string; role?: string; seatToken?: string; slug?: string; repo?: string }>
        slugToBrain?: Record<string, string>
      }
      const imported: BrainRec[] = []
      if (parsed.byBrain) {
        for (const [id, seat] of Object.entries(parsed.byBrain)) {
          imported.push({
            id,
            email: String(seat.email || ''),
            role: String(seat.role || ''),
            token: String(seat.seatToken || ''),
            owner: want,
            slug: String(seat.slug || ''),
            repo: String(seat.repo || '')
          })
        }
      } else if (parsed.id) {
        imported.push({
          id: parsed.id,
          email: String(parsed.email || ''),
          role: String(parsed.role || ''),
          token: String(parsed.token || ''),
          owner: want,
          slug: String(parsed.slug || ''),
          repo: String(parsed.repo || '')
        })
      }
      if (imported.length) {
        brains = imported
        slugs = {}
        for (const [slug, id] of Object.entries(parsed.slugToBrain || {})) {
          if (slug && id) slugs[slug.toLowerCase()] = String(id)
        }
        for (const brain of imported) {
          if (brain.slug) slugs[brain.slug.toLowerCase()] = brain.id
        }
      }
    }
  }
  const mine = brains.filter((b) => b.owner === want)
  save({ ...row, shellEmail: want, brains, slugs, activeId: mine[0]?.id || row.activeId })
  return want
}

export function loginFromCompanySetup(brainId: string, ownerEmail: string, role: string, token: string): string {
  const row = current()
  if (row.shellEmail !== 'joe@plyntr.com') return row.shellEmail
  const existing = row.brains.find((b) => b.id === brainId)
  const next: BrainRec = { id: brainId, email: ownerEmail, role, token, owner: row.shellEmail, slug: existing?.slug || '', repo: existing?.repo || '' }
  const brains = existing ? row.brains.map((b) => (b.id === brainId ? next : b)) : [...row.brains, next]
  save({ ...row, brains, activeId: brainId })
  return row.shellEmail
}

export function logoutShell(): void {
  const row = current()
  save({ ...row, shellEmail: '', activeId: '' })
}

export function rememberKeylessFolder(id: string, label: string): void {
  const row = current()
  if (row.keyless.some((k) => k.id === id)) return
  save({ ...row, keyless: [...row.keyless, { id, label }] })
}

export function shellView(): ShellView {
  const row = current()
  return {
    email: row.shellEmail,
    flag: row.flag,
    signedIn: row.brains.filter((b) => b.owner === row.shellEmail).map((b) => b.id),
    keyless: isJoeSuperAdmin({ email: row.shellEmail, flag: row.flag }) ? row.keyless.map((k) => k.id) : []
  }
}

export function listAllowed(): string[] {
  return allowedFolders(shellView())
}

export function switchVisible(): boolean {
  return showBrainSwitch(shellView())
}

export function canSwitchBrain(id: string): boolean {
  return listAllowed().includes(id)
}

export function switchShellBrain(id: string): void {
  if (!canSwitchBrain(id)) throw new Error('That brain is not open to this login.')
  const row = current()
  save({ ...row, activeId: id })
}

export function storeOwnedSeat(id: string, email: string, role: string, token: string, slug = '', repo = ''): void {
  const row = current()
  if (!row.shellEmail || !id || !token) return
  const existing = row.brains.find((b) => b.id === id)
  if (existing && existing.owner !== row.shellEmail) return
  const next: BrainRec = {
    id,
    email,
    role,
    token,
    owner: row.shellEmail,
    slug: slug || existing?.slug || '',
    repo: repo || existing?.repo || ''
  }
  const brains = existing ? row.brains.map((b) => (b.id === id ? next : b)) : [...row.brains, next]
  const slugs = { ...row.slugs }
  if (next.slug) slugs[next.slug.toLowerCase()] = id
  save({ ...row, brains, slugs, activeId: row.activeId || id })
}

export function idForSlug(slug: string): string {
  return current().slugs[String(slug || '').trim().toLowerCase()] || ''
}

export function bindBrainFolder(folder: string, id: string): void {
  const row = current()
  save({ ...row, folders: { ...row.folders, [folder]: id } })
}

function readToken(idOrFolder: string): string {
  const row = current()
  const hit = owned(row, idFor(row, idOrFolder))
  return hit ? hit.token : ''
}

export function seatTokenForFolderFromVault(id: string): string {
  return readToken(id)
}

export function seatTokenForBrainFromVault(id: string): string {
  return readToken(id)
}

export function gitSyncTokenFromVault(id: string): string {
  return readToken(id)
}

export function roleForBrainWriteFromVault(idOrFolder: string): string {
  const row = current()
  const id = idFor(row, idOrFolder)
  if (!readToken(id)) return ''
  return owned(row, id)?.role || ''
}

export function activeToken(): string {
  const row = current()
  return readToken(row.activeId)
}

export function activeRole(): string {
  const row = current()
  return roleForBrainWriteFromVault(row.activeId)
}

export function seatForId(id: string): SeatLabel {
  const row = current()
  const hit = owned(row, id)
  if (hit) return { email: hit.email, token: hit.token, label: '' }
  const keyless = row.keyless.find((k) => k.id === id)
  if (keyless) return { label: keyless.label }
  return {}
}

export function activeSeat(): SeatLabel {
  const row = current()
  const hit = owned(row, row.activeId)
  if (hit) return { email: hit.email, token: hit.token, label: '' }
  const keyless = row.keyless.find((k) => k.id === row.activeId)
  if (keyless) return { label: keyless.label }
  return {}
}

export function activeSeatId(): string {
  return current().activeId
}

export function labelForActive(): string {
  return openBrainAccountLabel(activeSeat())
}

export function keyCount(): number {
  const email = current().shellEmail
  return current().brains.filter((b) => b.owner === email).length
}

export function brainRow(id: string): BrainRec | null {
  return current().brains.find((b) => b.id === id) || null
}

export function snapshot(): string {
  const row = current()
  return JSON.stringify({ shellEmail: row.shellEmail, activeId: row.activeId, brains: row.brains, keyless: row.keyless })
}

export function addCompanyVisible(): boolean {
  const row = current()
  return showAddCompany({ email: row.shellEmail, flag: row.flag })
}
