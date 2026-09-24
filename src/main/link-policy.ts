import { dirname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { WebContents } from 'electron'

export type OpenOutside = (url: string) => void

export type AllowList = {
  dev?: URL
  fileRoot?: string
}

const LOOP = new Set(['localhost', '127.0.0.1'])

export function appAllowList(input: { devUrl?: string; packagedIndex?: string }): AllowList {
  const allow: AllowList = {}
  const devUrl = String(input.devUrl || '').trim()
  if (devUrl) {
    try {
      const dev = new URL(devUrl)
      if (dev.protocol === 'http:' || dev.protocol === 'https:') allow.dev = dev
    } catch {
      /* not a document URL */
    }
  }
  const index = String(input.packagedIndex || '').trim()
  if (index) allow.fileRoot = resolve(dirname(index))
  return allow
}

function parsed(url: string): URL | null {
  try {
    return new URL(url)
  } catch {
    return null
  }
}

function sameDev(target: URL, dev: URL): boolean {
  if (target.protocol !== dev.protocol) return false
  if (String(target.port || '') !== String(dev.port || '')) return false
  const a = target.hostname.toLowerCase()
  const b = dev.hostname.toLowerCase()
  if (a === b) return true
  return LOOP.has(a) && LOOP.has(b)
}

function filePath(url: string): string | null {
  try {
    if (!parsed(url) || !url.startsWith('file:')) return null
    return resolve(fileURLToPath(url))
  } catch {
    return null
  }
}

function fileInside(url: string, root: string): boolean {
  const resolved = filePath(url)
  if (!resolved) return false
  const base = resolve(root)
  return resolved === base || resolved.startsWith(base + sep)
}

function sameFileTree(url: string, home: string): boolean {
  const target = filePath(url)
  const homePath = filePath(home)
  if (!target || !homePath) return false
  const base = dirname(homePath)
  return target === homePath || target.startsWith(base + sep)
}

export type NavDecision = 'stay' | 'open' | 'drop'

export function decideMain(url: string, allow: AllowList): NavDecision {
  const u = parsed(url)
  if (!u) return 'drop'
  if (u.protocol === 'javascript:' || u.protocol === 'data:') return 'drop'
  if (allow.dev && sameDev(u, allow.dev)) return 'stay'
  if (allow.fileRoot && fileInside(url, allow.fileRoot)) return 'stay'
  if (u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'mailto:') return 'open'
  return 'drop'
}

function canOpen(url: string): boolean {
  const u = parsed(url)
  if (!u) return false
  return u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'mailto:'
}

function openKey(url: string): string {
  return String(url || '').replace(/\/$/, '')
}

function makeOpenOnce(open: OpenOutside): (url: string) => void {
  let lastKey = ''
  let lastAt = 0
  return (url: string) => {
    const key = openKey(url)
    const now = Date.now()
    if (key === lastKey && now - lastAt < 80) return
    lastKey = key
    lastAt = now
    open(url)
  }
}

type NavDetails = { preventDefault: () => void; url?: string }

function readUrl(details: NavDetails, deprecatedUrl?: string): string {
  return String(details?.url || deprecatedUrl || '')
}

export function attachMainLinks(
  webContents: WebContents,
  opts: { open: OpenOutside; allow: AllowList }
): void {
  const openOnce = makeOpenOnce(opts.open)
  const onDocument = (details: NavDetails, deprecatedUrl?: string) => {
    const url = readUrl(details, deprecatedUrl)
    const decision = decideMain(url, opts.allow)
    if (decision === 'stay') return
    details.preventDefault()
    if (decision === 'open') openOnce(url)
  }
  webContents.on('will-navigate', onDocument)
  webContents.on('will-redirect', onDocument)
  webContents.setWindowOpenHandler(({ url }) => {
    if (decideMain(url, opts.allow) === 'open') openOnce(url)
    return { action: 'deny' }
  })
}

export function installGuestLinkPolicy(webContents: WebContents, open: OpenOutside): void {
  webContents.on('did-attach-webview', (_event, guest) => {
    let home = ''
    const openOnce = makeOpenOnce(open)
    const rememberHome = () => {
      if (home) return
      try {
        const current = guest.getURL()
        if (current.startsWith('file:')) home = current
      } catch {
        /* guest already gone */
      }
    }
    const onGuest = (details: NavDetails, deprecatedUrl?: string) => {
      const url = readUrl(details, deprecatedUrl)
      rememberHome()
      if (!home && url.startsWith('file:')) home = url
      if (home && sameFileTree(url, home)) return
      details.preventDefault()
      if (canOpen(url)) openOnce(url)
    }
    guest.on('did-navigate', () => rememberHome())
    guest.on('will-navigate', onGuest)
    guest.on('will-redirect', onGuest)
    guest.setWindowOpenHandler(({ url }) => {
      rememberHome()
      if (!(home && sameFileTree(url, home)) && canOpen(url)) openOnce(url)
      return { action: 'deny' }
    })
  })
}
