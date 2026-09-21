export function sameCwd(a: string, b: string): boolean {
  const n = (p: string) => String(p || '').replace(/\\/g, '/').replace(/\/$/, '')
  return n(a) === n(b)
}

export function outsideProject(cwd: string, file: string): string | null {
  const root = String(cwd || '').replace(/\\/g, '/').replace(/\/$/, '')
  let p = String(file || '').replace(/\\/g, '/')
  if (!p) return null
  if (!p.startsWith('/')) {
    if (!root) return null
    p = `${root}/${p.replace(/^\.\//, '')}`
  }
  if (root && (p === root || p.startsWith(root + '/'))) return null
  const parts = p.split('/').filter(Boolean)
  const home = parts[0] === 'Users' || parts[0] === 'home'
  if (home && parts.length >= 4) return '/' + parts.slice(0, 4).join('/')
  if (parts.length >= 3) return '/' + parts.slice(0, 3).join('/')
  return p.startsWith('/') ? p : null
}
