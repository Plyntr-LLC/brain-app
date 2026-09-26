export const EXPLAIN_STEP = 'Explain this step.'

const BANNED = [
  'send mail',
  'send an email',
  'send email',
  'change google ads',
  'change the ads',
  'install the github app',
  'install a github app',
  'install github'
]

export function setupPrompt(heading: string): string {
  return `${String(heading || '').trim()}\n${EXPLAIN_STEP}`
}

export function promptAllowed(text: string): boolean {
  const low = String(text || '').toLowerCase()
  return !BANNED.some((phrase) => low.includes(phrase))
}

export function joinConfirmed(
  st: { installed?: boolean; repositorySelection?: string; repo?: string } | null,
  expectedRepo: string
): boolean {
  if (st?.installed !== true) return false
  const sel = String(st.repositorySelection || '').toLowerCase()
  if (sel === 'all' || sel === 'all_repositories') return false
  const repo = String(st.repo || '').trim().toLowerCase()
  const want = String(expectedRepo || '').trim().toLowerCase()
  return Boolean(repo && want && repo === want)
}

export function plyntrJoinButtons(opts: { role: string; pending: boolean }): string[] {
  const role = String(opts.role || '')
  if (role === 'team' || role === 'project' || opts.pending) return ['Check again']
  return ['Open GitHub', 'Check GitHub']
}

export function agencyVerifyButtons(role: string): string[] {
  const who = String(role || '')
  if (who === 'team' || who === 'project') return ['Check again']
  return ['Open GitHub']
}

export function chatOpened(signedIn: boolean, git: boolean, cloudflared: boolean): boolean {
  return Boolean(signedIn && git && cloudflared)
}

/** Recheck copy when setup is not ready. Do not tell people to finish an installer that never opened. */
export function recheckMissingLine(
  items: { id: string; label: string; present: boolean }[],
  wantCli: Record<string, boolean>
): string {
  const need = new Set(['git', 'brew', 'cloudflared'])
  for (const id of ['grok', 'claude', 'cursor', 'gpt']) {
    if (wantCli[id]) need.add(id)
  }
  const names = items.filter((row) => need.has(row.id) && !row.present).map((row) => row.label)
  if (names.length === 1) {
    return `${names[0]} is still missing. If no installer window opened, click Start setup again.`
  }
  if (names.length) {
    return `${names.join(', ')} are still missing. If no installer window opened, click Start setup again.`
  }
  return 'Chat is not ready yet. Sign in to the AI you picked, then Recheck.'
}

const SKIP_PREFIX = ['skills/', '.grok/', '.team-config/', '.git/']

export function draftFileAction(
  rel: string,
  draft: Buffer | null,
  fixture: Buffer | null,
  clone: Buffer | null
): 'copy' | 'leave' {
  const path = String(rel || '').replace(/\\/g, '/').replace(/^\.\//, '')
  if (!path || path === '.git' || path === '.team-config') return 'leave'
  if (SKIP_PREFIX.some((prefix) => path.startsWith(prefix))) return 'leave'
  if (!path.startsWith('context/')) return 'leave'
  if (!draft) return 'leave'
  const differs = fixture ? !draft.equals(fixture) : true
  if (!differs) return 'leave'
  if (!clone) return 'copy'
  if (fixture && clone.equals(fixture)) return 'copy'
  return 'leave'
}

export type PackEntry = string | { from?: string; to?: string; filter?: string[] }

function globToRegExp(pattern: string): RegExp {
  const body = pattern.replace(/\\/g, '/').replace(/\/+$/, '')
  const escaped = body
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*')
  return new RegExp(`^${escaped}$`)
}

function globHit(pattern: string, rel: string): boolean {
  const file = rel.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
  const re = globToRegExp(pattern)
  return re.test(file)
}

export function packShipsFile(entries: PackEntry[], relFile: string): boolean {
  const rel = relFile.replace(/\\/g, '/').replace(/^\.\//, '')
  for (const entry of entries) {
    if (typeof entry === 'string') {
      if (globHit(entry, rel)) return true
      continue
    }
    const from = String(entry.from || '').replace(/\\/g, '/').replace(/\/+$/, '')
    const filters = entry.filter?.length ? entry.filter : ['**/*']
    for (const filter of filters) {
      const raw = String(filter || '')
      if (from && globHit(`${from}/${raw}`, rel)) return true
      if (from && rel.startsWith(`${from}/`) && globHit(raw, rel.slice(from.length + 1))) return true
      if (!from && globHit(raw, rel)) return true
    }
  }
  return false
}
