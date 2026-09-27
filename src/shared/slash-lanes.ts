/** Terminal chrome in the CLI's own TUI. Skin has no chat equivalent, so these get a note, not a PTY write. */
export const TUI_ONLY_SLASH = new Set(['theme', 'vim-mode', 'fullscreen', 'minimal', 'dashboard', 'compact-mode'])

/** Names Brain answers itself (plus their aliases). A disk skill with one of these names never steals it. */
export const APP_SLASH = new Set([
  'new',
  'clear',
  'delete',
  'help',
  'skills',
  'usage',
  'cost',
  'model',
  'm',
  'effort',
  'copy',
  'export',
  'quit',
  'exit',
  'rename',
  'title',
  'history',
  'resume',
  'fork',
  'login',
  'logout',
  'doctor',
  'terminal',
  'home',
  'welcome',
  'rewind',
  'undo',
  'edit-prompt',
  'multiline',
  'always-approve',
  'auto',
  'timestamps',
  'compact'
])
