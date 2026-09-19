/** owner/name from a git remote or a pasted GitHub URL. Empty if it is not GitHub. */
export function parseGithubHqRepo(raw: string): string {
  const s = String(raw || '').trim()
  if (!s) return ''
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(s)) return s
  const noGit = s.replace(/\.git$/i, '')
  const m = noGit.match(/github\.com[:/]([^/\s]+)\/([^/#?\s]+)/i)
  if (!m) return ''
  return `${m[1]}/${m[2]}`
}
