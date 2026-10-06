export type TitleSync = { ok: boolean; line: string; attention?: boolean; tip?: string }

/** The window's top row: brain name, role, sync pill, theme icon, Log out and Settings. */
export function TitleBar({
  title,
  role,
  brainKind,
  account,
  sync,
  watching,
  discardNote,
  onDiscard,
  theme,
  setTheme,
  showLogout,
  onLogout,
  settingsOpen,
  onSettings
}: {
  title: string
  role?: string
  brainKind?: string
  account: string
  sync: TitleSync | null
  watching?: boolean
  discardNote: string
  onDiscard: () => void
  theme: 'light' | 'dark'
  setTheme: (t: 'light' | 'dark') => void
  showLogout: boolean
  onLogout: () => void
  settingsOpen: boolean
  onSettings: () => void
}) {
  const themeName = theme === 'dark' ? 'Light mode' : 'Dark mode'
  return (
    <div className="titlebar">
      <span>{title}</span>
      {role && !account ? (
        <span className="role-lock">
          {role === 'project' ? 'Project only' : role === 'team' || role === 'member' ? 'Team' : role === 'scout' ? 'Scout' : 'Owner'}
          {brainKind === 'project' ? ' · project' : brainKind === 'hq' ? ' · HQ' : ''}
        </span>
      ) : null}
      <span className={`sync-pill ${sync?.ok ? 'on' : ''}`} title={sync?.tip || sync?.line || ''}>
        {sync?.line ||
          (watching
            ? role === 'project' || brainKind === 'project'
              ? 'Project folders syncing'
              : 'Agency Brain · watching this folder'
            : 'Folder not syncing')}
      </span>
      {sync?.attention ? (
        <button type="button" className="ghost title-set" title={discardNote || 'Drop the commits that exist only on this computer'} onClick={onDiscard}>
          Discard my changes
        </button>
      ) : null}
      {sync?.attention && discardNote ? <span className="sync-pill">{discardNote}</span> : null}
      {account ? <span className="seat-pill">{account}</span> : null}
      <button type="button" className="ghost title-set title-icon" aria-label={themeName} title={themeName} onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
        ◐
      </button>
      {showLogout ? (
        <button type="button" className="ghost title-set" onClick={onLogout}>
          Log out
        </button>
      ) : null}
      <button type="button" className="ghost title-set settings-toggle" aria-expanded={settingsOpen} onClick={onSettings}>
        Settings
      </button>
    </div>
  )
}
