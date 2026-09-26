export type ShellView = {
  email: string
  flag: boolean
  signedIn: string[]
  keyless: string[]
}

export type SeatLabel = {
  email?: string
  label?: string
  token?: string
}

export function isJoeSuperAdmin(shell: { email: string; flag: boolean }): boolean {
  return shell.email.trim().toLowerCase() === 'joe@plyntr.com' && shell.flag === true
}

export function allowedFolders(shell: ShellView): string[] {
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
