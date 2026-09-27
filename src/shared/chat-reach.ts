// Chat, Skin and Show terminal reach: the same files and commands as the login Terminal tab.
// Factory does not use any of this; it keeps its own gated args and env.

export const CHAT_RULES =
  'You are the brain on this computer. Answer in plain English. You may read, edit, and run commands anywhere this Mac\'s signed-in user can, the same as their Terminal. The open folder is where to start, not a wall. Do not dump tool names or keyboard shortcuts. Never change Google Ads unless the human clearly said yes. Never send external mail unless they said send.'

/** Claude warm session permission args. Plan tabs stay `plan`; the allow flag lets plan off go to bypass. */
export function claudeChatPermissionArgs(plan: boolean): string[] {
  return ['--permission-mode', claudeChatMode(plan), '--allow-dangerously-skip-permissions']
}

export function claudeChatMode(plan: boolean): 'plan' | 'bypassPermissions' {
  return plan ? 'plan' : 'bypassPermissions'
}

/** Cursor Chat and Show terminal: open folder stays the workspace, no sandbox, home added as a root. */
export function cursorReachArgs(cwd: string, home: string): string[] {
  return ['--trust', '--workspace', cwd, '--sandbox', 'disabled', '--add-dir', home]
}

/** Codex app-server `thread/start` sandbox for Chat. Unrestricted, like Terminal. */
export const CODEX_CHAT_SANDBOX = 'danger-full-access'

/** Env names that pin a CLI to one folder. Chat, Skin and Show terminal never set these. */
export const PROJECT_DIR_ENV = ['CLAUDE_PROJECT_DIR', 'CURSOR_PROJECT_DIR', 'GROK_WORKSPACE_ROOT', 'CODEX_PROJECT_DIR'] as const
