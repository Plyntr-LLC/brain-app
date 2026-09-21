export type FileHit = { path: string; tool?: string; live?: boolean }

export { cleanThink, escapeHtml, mdToHtml, stripAnsi, tidy } from '../../shared/md'

const TOOL =
  /^(read_file|Read(?:ing)?(?: file)?|grep|list_dir|search_replace|glob_file_search|web_search|web_fetch|bash|Write|Edit|tool_call|available_commands|auto-accept|Always allow|shift\+tab|ctrl\+|Worked for|tokens)\b/i

const PATH_RE =
  /(?:^|[\s`'"(])((?:context|clients|personal|\.claude|\.agents|\.grok|CLAUDE|AGENTS|docs|plans|missions|todo)[^\s`'":]+|[A-Za-z0-9._/-]+\.(?:md|ts|tsx|js|cjs|json|html))/g

export function isNoise(line: string): boolean {
  const t = line.trim()
  if (!t) return true
  if (t.length < 3) return true
  if (/^[{[]/.test(t)) return true
  if (TOOL.test(t)) return true
  if (/^(esc|✓|●|○|…|Thinking…)$/i.test(t)) return true
  if (/^[\w./-]+\.(md|ts|tsx|js|json|cjs|html)$/.test(t) && !t.includes(' ')) return true
  const words = t.split(/\s+/).filter(Boolean)
  if (words.length <= 2 && /[/]/.test(t) && /\.(md|ts|json)/.test(t)) return true
  return false
}

export function isProse(line: string): boolean {
  const t = line.trim()
  if (isNoise(t)) return false
  const words = t.split(/\s+/).filter(Boolean)
  if (words.length >= 4) return true
  if (/\*\*|^\s*[-*]\s+\S/.test(t)) return true
  return words.length >= 3 && /[a-z]/.test(t)
}

export function extractFiles(cwd: string, text: string): FileHit[] {
  const hits: FileHit[] = []
  const re = new RegExp(PATH_RE.source, 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    let p = m[1].replace(/[.,;:]+$/, '')
    if (p.length < 4) continue
    const abs = p.startsWith('/') ? p : `${cwd.replace(/\/$/, '')}/${p}`
    if (!hits.some((h) => h.path === abs)) hits.push({ path: abs, live: true })
  }
  return hits
}
