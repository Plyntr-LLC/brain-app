export type ShellView = {
  email: string
  flag: boolean
  signedIn: string[]
  keyless: string[]
  /** Brain folders on this computer (brains.json). When present, the switcher lists folders by path. */
  local?: { path: string; brainId?: string }[]
}

export type SeatLabel = {
  email?: string
  label?: string
  token?: string
}

export function isJoeSuperAdmin(shell: { email: string; flag: boolean }): boolean {
  return shell.email.trim().toLowerCase() === 'joe@plyntr.com' && shell.flag === true
}

/** One Switch brain option: the select's value is always the folder path. */
export function switchOption<B extends { path: string; brainId?: string }>(id: string, brains: B[]): { key: string; path: string; brain: B | undefined } {
  const brain = brains.find((row) => row.path === id) || brains.find((row) => Boolean(row.brainId) && row.brainId === id)
  return { key: id, path: brain?.path || id, brain }
}

export function allowedFolders(shell: ShellView): string[] {
  if (shell.local) {
    const local = shell.local.filter((row) => row.path)
    const mine = shell.signedIn.flatMap((id) => local.filter((row) => row.brainId === id).map((row) => row.path))
    if (!isJoeSuperAdmin(shell)) return [...new Set(mine)]
    return [...new Set([...mine, ...local.map((row) => row.path)])]
  }
  if (isJoeSuperAdmin(shell)) return [...shell.signedIn, ...shell.keyless]
  return [...shell.signedIn]
}

export function showBrainSwitch(shell: ShellView): boolean {
  return allowedFolders(shell).length >= 2
}

export function showAddCompany(shell: { email: string; flag: boolean }): boolean {
  return isJoeSuperAdmin(shell)
}

export function openBrainAccountLabel(seat: SeatLabel): string {
  if (seat.token) return seat.email || ''
  return seat.label || ''
}
