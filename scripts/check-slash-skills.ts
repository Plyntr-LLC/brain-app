import { createRequire, registerHooks } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// Drives the real main-process modules: slash-skills (expand), slash (listSlash) and
// claude-usage (formatClaudeUsage + formatClaudeStats). HOME points at an empty temp dir
// so nothing on this Mac's ~/.claude leaks into the result.

const self = fileURLToPath(import.meta.url)
const rootRepo = join(dirname(self), '..')
const esbuild = createRequire(join(rootRepo, 'package.json'))('esbuild') as {
  transformSync: (code: string, opts: Record<string, unknown>) => { code: string }
}

registerHooks({
  resolve(spec, ctx, next) {
    if (spec === 'electron') return { url: 'stub:electron', shortCircuit: true }
    if ((spec.startsWith('./') || spec.startsWith('../')) && ctx.parentURL?.startsWith('file:') && !/\.(ts|js|mjs|cjs|json)$/.test(spec)) {
      const base = resolvePath(dirname(fileURLToPath(ctx.parentURL)), spec)
      for (const file of [`${base}.ts`, join(base, 'index.ts')]) {
        if (existsSync(file)) return { url: pathToFileURL(file).href, shortCircuit: true }
      }
    }
    return next(spec, ctx)
  },
  load(url, ctx, next) {
    if (url === 'stub:electron') {
      const source = `export const app = { getVersion: () => '0.0.0', getPath: () => ${JSON.stringify(tmpdir())}, isPackaged: false }
export const BrowserWindow = { getAllWindows: () => globalThis.__brainWindows || [] }
export const clipboard = {}, dialog = {}, ipcMain = { handle() {}, on() {} }, Menu = {}, nativeImage = {}, shell = {}, Tray = class {}
export default { app, BrowserWindow }`
      return { format: 'module', shortCircuit: true, source }
    }
    if (url.startsWith('file:') && url.endsWith('.ts') && url.includes('/src/')) {
      const code = esbuild.transformSync(readFileSync(fileURLToPath(url), 'utf8'), { loader: 'ts', format: 'esm', target: 'node22' }).code
      return { format: 'module', shortCircuit: true, source: code }
    }
    return next(url, ctx)
  }
})

const temp = mkdtempSync(join(tmpdir(), 'brain-slash-'))
const cwd = join(temp, 'brain')
const home = join(temp, 'home')
mkdirSync(home, { recursive: true })
process.env.HOME = home
delete process.env.BRAIN_APP_DRY_RUN
delete process.env.CODEX_HOME

mkdirSync(join(cwd, '.claude', 'skills', 'save'), { recursive: true })
writeFileSync(
  join(cwd, '.claude', 'skills', 'save', 'SKILL.md'),
  '---\nname: save\ndescription: "Team-friendly save and sync."\n---\n\n# Save\n\nSAVE_SKILL_MARKER_9f3\n\nAsk before you save.\n'
)
mkdirSync(join(cwd, '.claude', 'skills', 'usage'), { recursive: true })
writeFileSync(join(cwd, '.claude', 'skills', 'usage', 'SKILL.md'), '# Usage\n\nUSAGE_SKILL_SHOULD_NOT_WRAP\n')

// Second brain with the skill only under .grok/skills, plus a home-only Claude command and a skills skill.
const grokCwd = join(temp, 'grok-brain')
mkdirSync(join(grokCwd, '.grok', 'skills', 'save'), { recursive: true })
writeFileSync(join(grokCwd, '.grok', 'skills', 'save', 'SKILL.md'), '---\ndescription: Grok save.\n---\n\nGROK_SAVE_MARKER_71c\n')
mkdirSync(join(home, '.claude', 'commands'), { recursive: true })
writeFileSync(join(home, '.claude', 'commands', 'gm.md'), '# Good morning\n\nHOME_GM_MARKER_4d2\n')
mkdirSync(join(home, '.grok', 'skills', 'deep-review'), { recursive: true })
writeFileSync(join(home, '.grok', 'skills', 'deep-review', 'SKILL.md'), '# Deep review\n\nHOME_GROK_MARKER_a81\n')
mkdirSync(join(cwd, '.claude', 'skills', 'skills'), { recursive: true })
writeFileSync(join(cwd, '.claude', 'skills', 'skills', 'SKILL.md'), '# Skills\n\nSKILLS_SKILL_SHOULD_NOT_WRAP\n')
// Roots people actually use: synced Claude skills, nested Claude commands, repo .codex/skills,
// Codex home skills and prompts, and a Claude plugin skill, plus a symlink that must not be walked.
mkdirSync(join(home, '.claude', 'skills', 'synced', 'acct-1', 'standup'), { recursive: true })
writeFileSync(join(home, '.claude', 'skills', 'synced', 'acct-1', 'standup', 'SKILL.md'), '---\ndescription: Synced standup.\n---\n\nSYNCED_STANDUP_MARKER_5e0\n')
mkdirSync(join(cwd, '.claude', 'commands', 'ads'), { recursive: true })
writeFileSync(join(cwd, '.claude', 'commands', 'ads', 'audit.md'), '# Ads audit\n\nNS_AUDIT_MARKER_c13\n')
mkdirSync(join(cwd, '.codex', 'skills', 'ship'), { recursive: true })
writeFileSync(join(cwd, '.codex', 'skills', 'ship', 'SKILL.md'), '# Ship\n\nREPO_CODEX_SHIP_MARKER_2b7\n')
mkdirSync(join(home, '.codex', 'skills', 'lint'), { recursive: true })
writeFileSync(join(home, '.codex', 'skills', 'lint', 'SKILL.md'), '# Lint\n\nCODEX_HOME_LINT_MARKER_8a1\n')
mkdirSync(join(home, '.codex', 'prompts'), { recursive: true })
writeFileSync(join(home, '.codex', 'prompts', 'recap.md'), '# Recap\n\nCODEX_PROMPT_MARKER_d90\n')
const pluginSkill = join(home, '.claude', 'plugins', 'marketplaces', 'acme', 'plugins', 'tools', 'skills', 'deploy')
mkdirSync(pluginSkill, { recursive: true })
writeFileSync(join(pluginSkill, 'SKILL.md'), '# Deploy\n\nPLUGIN_DEPLOY_MARKER_e44\n')
const outside = join(temp, 'outside')
mkdirSync(join(outside, 'skills', 'escape'), { recursive: true })
writeFileSync(join(outside, 'skills', 'escape', 'SKILL.md'), '# Escape\n\nSYMLINK_ESCAPE_SHOULD_NOT_LOAD\n')
symlinkSync(outside, join(home, '.claude', 'plugins', 'marketplaces', 'linked'))
const codexDay = join(home, '.codex', 'sessions', '2026', '09', '27')
mkdirSync(codexDay, { recursive: true })
writeFileSync(
  join(codexDay, 'rollout-2026-09-27T10-00-00-fixture.jsonl'),
  [
    JSON.stringify({ timestamp: '2026-09-27T10:00:00.000Z', type: 'event_msg', payload: { type: 'token_count', info: null, rate_limits: { limit_id: 'codex', primary: { used_percent: 42.4, window_minutes: 300, resets_at: 4102444800 }, secondary: { used_percent: 7, window_minutes: 10080, resets_at: 4102531200 }, plan_type: 'plus' } } }),
    JSON.stringify({ timestamp: '2026-09-27T10:05:00.000Z', type: 'event_msg', payload: { type: 'token_count', info: null, rate_limits: { limit_id: 'premium', primary: null, secondary: null, plan_type: null } } }),
    ''
  ].join('\n')
)

const src = (p: string) => pathToFileURL(join(rootRepo, 'src', 'main', p)).href
const { expandSlash } = (await import(src('slash-skills.ts'))) as typeof import('../src/main/slash-skills.ts')
const { listSlash } = (await import(src('slash.ts'))) as typeof import('../src/main/slash.ts')
const { formatCodexLimits, readCodexLimits } = (await import(src('codex-usage.ts'))) as typeof import('../src/main/codex-usage.ts')
const { gptUsageBlurb } = (await import(src('slash.ts'))) as typeof import('../src/main/slash.ts')
const { routeLine } = (await import(pathToFileURL(join(rootRepo, 'src', 'shared', 'slash-route.ts')).href)) as typeof import('../src/shared/slash-route.ts')
const { APP_SLASH } = (await import(pathToFileURL(join(rootRepo, 'src', 'shared', 'slash-lanes.ts')).href)) as typeof import('../src/shared/slash-lanes.ts')
const { formatClaudeStats, formatClaudeUsage, formatClaudeOAuthUsage } = (await import(src('claude-usage.ts'))) as typeof import('../src/main/claude-usage.ts')
const { formatGrokAccount, formatGrokSession, grokUsageText } = (await import(src('grok-usage.ts'))) as typeof import('../src/main/grok-usage.ts')
const { grokUsageBlurb, claudeUsageBlurb } = (await import(src('slash.ts'))) as typeof import('../src/main/slash.ts')
const { PLAN_APPROVE, PLAN_KEEP } = (await import(src('grok-plan.ts'))) as typeof import('../src/main/grok-plan.ts')
const { handleReq, handleNote, answerPlanAsk, adoptLoadedSession, onPoolExit, acpCancel, acpClose, attachPool, detachPool } = (await import(src('acp-session.ts'))) as typeof import('../src/main/acp-session.ts')
const { newPlanControls, controlTimedOut, controlAnswered } = (await import(src('claude-plan.ts'))) as typeof import('../src/main/claude-plan.ts')
// Windows the main process broadcasts chat:event to (the electron stub reads this list).
const winSent: Record<string, unknown>[] = []
;(globalThis as { __brainWindows?: unknown }).__brainWindows = [{ isDestroyed: () => false, webContents: { send: (_ch: string, p: Record<string, unknown>) => winSent.push(p) } }]
const { panelBlocks } = (await import(pathToFileURL(join(rootRepo, 'src', 'shared', 'panel-blocks.ts')).href)) as typeof import('../src/shared/panel-blocks.ts')

const results: { name: string; ok: boolean; detail: string }[] = []
const check = (name: string, ok: boolean, detail = '') => results.push({ name, ok, detail })

const save = expandSlash(cwd, '/save')
check('expand /save display is /save', save?.display === '/save', JSON.stringify(save?.display))
check('expand /save prompt has marker', Boolean(save?.prompt.includes('SAVE_SKILL_MARKER_9f3')))
check('expand /save prompt has ask step', Boolean(save?.prompt.includes('Ask before you save')))
check('expand /save prompt does not start with /', Boolean(save && !/^\s*\//.test(save.prompt)))
const saveArgs = expandSlash(cwd, '/save  just the docs ')
check('expand /save args keeps display', saveArgs?.display === '/save just the docs', JSON.stringify(saveArgs?.display))
check('expand /usage is null', expandSlash(cwd, '/usage') === null)
check('expand /cost is null', expandSlash(cwd, '/cost') === null)
check('expand /compact is null', expandSlash(cwd, '/compact') === null)
check('expand /theme is null', expandSlash(cwd, '/theme') === null)
check('expand /nope is null', expandSlash(cwd, '/nope') === null)
for (const bad of ['../passwd', '/../passwd', '/etc/passwd', '/save/../../x', '/..', `/${join(cwd, '.claude')}`]) {
  check(`expand ${bad} refused`, expandSlash(cwd, bad) === null)
}

const grokSave = expandSlash(grokCwd, '/save')
check('expand .grok/skills-only /save', Boolean(grokSave?.prompt.includes('GROK_SAVE_MARKER_71c')), JSON.stringify(grokSave?.display))
check('expand .grok/skills /save display is /save', grokSave?.display === '/save')
const gm = expandSlash(grokCwd, '/gm')
check('expand home .claude/commands /gm', Boolean(gm?.prompt.includes('HOME_GM_MARKER_4d2')), JSON.stringify(gm?.display))
const deep = expandSlash(cwd, '/deep-review')
check('expand home .grok/skills /deep-review', Boolean(deep?.prompt.includes('HOME_GROK_MARKER_a81')))
check('cwd .claude/skills save beats nothing else', Boolean(save?.prompt.includes('SAVE_SKILL_MARKER_9f3')) && !save?.prompt.includes('GROK_SAVE_MARKER_71c'))
check('expand /skills is null even with a skills skill', expandSlash(cwd, '/skills') === null)
check('expand /help is null', expandSlash(cwd, '/help') === null)
for (const bad of ['/..%2Fx', '/.grok', '/save/SKILL', '/-x', '/gm.md']) {
  check(`expand ${bad} refused`, expandSlash(grokCwd, bad) === null)
}

const synced = expandSlash(cwd, '/standup')
check('expand ~/.claude/skills/synced/<id>/standup', Boolean(synced?.prompt.includes('SYNCED_STANDUP_MARKER_5e0')), JSON.stringify(synced?.display))
const nsAudit = expandSlash(cwd, '/ads:audit last 30 days')
check('expand nested .claude/commands/ads/audit.md as /ads:audit', Boolean(nsAudit?.prompt.includes('NS_AUDIT_MARKER_c13')) && nsAudit?.display === '/ads:audit last 30 days', JSON.stringify(nsAudit?.display))
check('expand /audit alone does not hit the namespaced command', expandSlash(cwd, '/audit') === null)
const repoCodex = expandSlash(cwd, '/ship')
check('expand repo .codex/skills /ship', Boolean(repoCodex?.prompt.includes('REPO_CODEX_SHIP_MARKER_2b7')))
check('expand ~/.codex/skills /lint', Boolean(expandSlash(cwd, '/lint')?.prompt.includes('CODEX_HOME_LINT_MARKER_8a1')))
check('expand ~/.codex/prompts /recap', Boolean(expandSlash(cwd, '/recap')?.prompt.includes('CODEX_PROMPT_MARKER_d90')))
check('expand ~/.claude/plugins/**/skills /deploy', Boolean(expandSlash(cwd, '/deploy')?.prompt.includes('PLUGIN_DEPLOY_MARKER_e44')))
check('plugin walk does not follow a symlink out', expandSlash(cwd, '/escape') === null)
const customHome = join(temp, 'codex-custom')
mkdirSync(join(customHome, 'skills', 'fmt'), { recursive: true })
writeFileSync(join(customHome, 'skills', 'fmt', 'SKILL.md'), '# Fmt\n\nCUSTOM_CODEX_HOME_MARKER_31f\n')
process.env.CODEX_HOME = customHome
check('expand $CODEX_HOME/skills /fmt', Boolean(expandSlash(cwd, '/fmt')?.prompt.includes('CUSTOM_CODEX_HOME_MARKER_31f')))
delete process.env.CODEX_HOME
for (const bad of ['/a:b:c', '/:audit', '/ads:', '/ads:../audit', '/ads/audit', '/-ads:audit', '/ads:-audit']) {
  check(`expand ${bad} refused`, expandSlash(cwd, bad) === null)
}

// 4. A / line never routes to the PTY, even with Show terminal open.
for (const line of ['/save', '/nope', '/theme', '/ads:audit x', '/compact', '/']) {
  check(`route ${line} with peel is warm`, routeLine(line, { peel: true }) === 'warm')
  check(`route ${line} without peel is warm`, routeLine(line, { peel: false }) === 'warm')
}
check('route plain text with peel is pty', routeLine('hello there', { peel: true }) === 'pty')
check('route plain text without peel is warm', routeLine('hello there', { peel: false }) === 'warm')

// 5. Every reserved name has a handler in runSlash (renderer), so no skill is blocked for nothing.
const renderer = readFileSync(join(rootRepo, 'src', 'renderer', 'src', 'TerminalWorkspace.tsx'), 'utf8')
check('renderer has no APP_ONLY copy', !/\bAPP_ONLY\b/.test(renderer))
check('renderer has no sendSkinTerm', !/\bsendSkinTerm\b/.test(renderer))
const runSlashBody = renderer.slice(renderer.indexOf('function runSlash('), renderer.indexOf('async function takeSlash('))
const handled = new Set([...runSlashBody.matchAll(/\bname === '([a-z-]+)'/g)].map((m) => m[1]))
const aliasBlock = renderer.match(/const SLASH_ALIAS[^{]*\{([\s\S]*?)\n\}/)?.[1] || ''
const alias = new Map([...aliasBlock.matchAll(/'?([a-z-]+)'?:\s*'([a-z-]+)'/g)].map((m) => [m[1], m[2]]))
const orphans = [...APP_SLASH].filter((n) => !handled.has(n) && !handled.has(alias.get(n) || ''))
check('every APP_SLASH name has a runSlash handler', orphans.length === 0, JSON.stringify(orphans))

const listed = await listSlash(cwd, 'claude')
const skillsRows = listed.commands.filter((c) => c.name === 'skills')
check('listSlash claude has one skills builtin', skillsRows.length === 1 && skillsRows[0].kind === 'builtin', JSON.stringify(skillsRows))
check('listSlash claude has home gm command', listed.commands.some((c) => c.name === 'gm' && c.kind === 'skill'))
check('listSlash claude has /ads:audit', listed.commands.some((c) => c.name === 'ads:audit' && c.kind === 'skill'))
check('listSlash claude has synced standup and plugin deploy', ['standup', 'deploy', 'ship'].every((n) => listed.commands.some((c) => c.name === n && c.kind === 'skill')))
check('listSlash claude has home grok deep-review', listed.commands.some((c) => c.name === 'deep-review' && c.kind === 'skill'))
const grokListed = await listSlash(grokCwd, 'claude')
check('listSlash claude in grok-only brain has save', grokListed.commands.some((c) => c.name === 'save' && c.kind === 'skill'))
const saveRow = listed.commands.find((c) => c.name === 'save')
check('listSlash claude has save skill', saveRow?.kind === 'skill', JSON.stringify(saveRow))
check('listSlash save description from front matter', saveRow?.description === 'Team-friendly save and sync.', JSON.stringify(saveRow?.description))
const usageRows = listed.commands.filter((c) => c.name === 'usage')
check('listSlash usage stays one builtin', usageRows.length === 1 && usageRows[0].kind === 'builtin', JSON.stringify(usageRows))
for (const kind of ['cursor', 'gpt']) {
  const rows = await listSlash(cwd, kind)
  check(`listSlash ${kind} has save skill`, rows.commands.some((c) => c.name === 'save' && c.kind === 'skill'))
}

const limits = readCodexLimits(home)
check('Codex meter reads last non-empty rate_limits', limits?.primary?.used_percent === 42.4 && limits?.plan === 'plus', JSON.stringify(limits))
const codexText = gptUsageBlurb(cwd, home)
check('Codex usage shows percent and window', codexText.includes('5-hour window: 42% used') && codexText.includes('7-day window: 7% used'), codexText)
check('Codex usage keeps chatgpt.com', codexText.includes('https://chatgpt.com'))
check('Codex usage has no grok.com or claude.ai', !codexText.includes('grok.com') && !codexText.includes('claude.ai'))
check('Codex meter past reset says reset', formatCodexLimits({ primary: { used_percent: 99, window_minutes: 60, resets_at: 1000 } }).includes('1-hour window: reset'))
check('Codex meter empty home is blank', formatCodexLimits(readCodexLimits(join(temp, 'nohome'))) === '')

const claudeText = [
  formatClaudeUsage(
    { loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max', email: 'ada@example.com' },
    cwd
  ),
  formatClaudeStats({
    lastComputedDate: '2026-09-27',
    totalSessions: 3,
    totalMessages: 42,
    modelUsage: { 'claude-opus-5-5': { inputTokens: 100, outputTokens: 200 } }
  })
].join('\n\n')
check('Claude usage has no grok.com', !claudeText.includes('grok.com'))
check('Claude usage keeps claude.ai usage link', claudeText.includes('claude.ai/settings/usage'))
check('Claude usage labels this Mac cache', claudeText.includes('This Mac’s Claude Code cache'))

// Claude account `/usage`: fake `GET /api/oauth/usage` bodies. Never a live account or keychain.
const claudeOAuthBody = {
  five_hour: { utilization: 42, resets_at: '2026-09-27T21:00:00Z' },
  seven_day: { utilization: 1, resets_at: '2026-10-02T13:00:00Z' },
  seven_day_sonnet: { utilization: 3, resets_at: '2026-10-02T13:00:00Z' },
  limits: [
    { kind: 'session', group: 'session', percent: 42, resets_at: '2026-09-27T21:00:00Z', severity: 'normal', is_active: true },
    { kind: 'weekly_scoped', group: 'weekly', percent: 20, resets_at: '2026-10-02T13:00:00Z', scope: { model: { display_name: 'Fable' } }, severity: 'normal', is_active: false }
  ],
  extra_usage: { is_enabled: true, monthly_limit: 5000, used_credits: 1234, utilization: 24.68, currency: 'USD' }
}
const claudeStatus = { loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max', email: 'ada@example.com' }
const claudeLive = await claudeUsageBlurb(cwd, {
  status: async () => claudeStatus,
  fetchUsage: async () => ({ usage: claudeOAuthBody }),
  stats: { totalSessions: 3, modelUsage: { 'claude-opus-5-5': { inputTokens: 100 } } },
  timeZone: 'America/New_York'
})
check('Claude /usage shows 5-hour percent', claudeLive.includes('Session (5-hour) used: 42%'), claudeLive)
check('Claude /usage shows weekly percent (1 means 1%, not a fraction)', claudeLive.includes('Weekly (all models) used: 1%'), claudeLive)
check('Claude /usage shows Sonnet and model weekly rows', claudeLive.includes('Weekly (Sonnet only) used: 3%') && claudeLive.includes('Weekly (Fable) used: 20%'))
check('Claude /usage shows reset in local time', /Session resets: Sun, Sep 27, 5:00\sPM/.test(claudeLive) && /Weekly resets: Fri, Oct 2, 9:00\sAM/.test(claudeLive), claudeLive)
check('Claude /usage shows one weekly reset line', claudeLive.split('Weekly resets:').length === 2)
check('Claude /usage shows credits left from the tighter window', claudeLive.includes('Credits left: 58%'))
check('Claude /usage shows extra usage in dollars', claudeLive.includes('Extra usage: $12.34 of $50.00 this month'))
check('Claude /usage keeps plan, email, link, folder', claudeLive.includes('Plan: Claude Max') && claudeLive.includes('Email: ada@example.com') && claudeLive.includes('https://claude.ai/settings/usage') && claudeLive.includes(`This folder: ${cwd}`))
check('Claude /usage has no grok.com', !/grok\.com|Grok/.test(claudeLive))
check('Claude /usage stats-cache is an extra block after the meter', claudeLive.indexOf('Session (5-hour) used') < claudeLive.indexOf('This Mac’s Claude Code cache'))
check('Claude /usage drops the no-meter sentence when the meter loaded', !claudeLive.includes('Session limits and billing live on the Claude account'))
const claudeBlocks = panelBlocks(claudeLive)
const claudeMeters = claudeBlocks.flatMap((b) => b.rows).filter((r) => r.kind === 'row' && r.percent != null) as { key: string; percent?: number }[]
check('Claude /usage popup heading is Claude account', claudeBlocks[0]?.heading === 'Claude account')
check(
  'Claude /usage popup draws meters for 5-hour and weekly',
  claudeMeters.some((r) => r.key === 'Session (5-hour) used' && r.percent === 42) && claudeMeters.some((r) => r.key === 'Weekly (all models) used' && r.percent === 1),
  JSON.stringify(claudeMeters)
)
const claudeHeaderShape = formatClaudeOAuthUsage(
  { rateLimitType: 'five_hour', resetsAt: 1790000000, unifiedWindows: { five_hour: { utilization: 0.37, resetsAt: 1790000000 }, seven_day: { utilization: 0.5, resetsAt: 1790500000 } } },
  { timeZone: 'America/New_York' }
).join('\n')
check('Claude header-shape fractions become percents', claudeHeaderShape.includes('Session (5-hour) used: 37%') && claudeHeaderShape.includes('Weekly (all models) used: 50%'), claudeHeaderShape)
check('Claude limits[] alone still gives the session meter', formatClaudeOAuthUsage({ limits: claudeOAuthBody.limits }).includes('Session (5-hour) used: 42%'))
const claudeDown = await claudeUsageBlurb(cwd, {
  status: async () => claudeStatus,
  fetchUsage: async () => ({ error: 'Could not reach Claude. Check this Mac is online.' }),
  stats: null
})
check(
  'Claude /usage fetch failure says so and keeps plan + link',
  claudeDown.includes('Could not load the usage meter. Could not reach Claude.') && claudeDown.includes('Plan: Claude Max') && claudeDown.includes('https://claude.ai/settings/usage') && !/used: \d/.test(claudeDown),
  claudeDown
)
const claudeThrow = await claudeUsageBlurb(cwd, {
  status: async () => claudeStatus,
  fetchUsage: async () => {
    throw new Error('TypeError: fetch failed at node:internal')
  },
  stats: null
})
check('Claude /usage never shows a raw fetch stack', !claudeThrow.includes('node:internal') && claudeThrow.includes('Could not load the usage meter.'), claudeThrow)
check('Claude /usage extra usage off', formatClaudeOAuthUsage({ five_hour: { utilization: 5 }, extra_usage: { is_enabled: false } }).includes('Extra usage: Off'))

// Grok account `/usage`: fake `_x.ai/billing` + `_x.ai/auth/check_subscription` replies. Never a live account.
const grokBillingWeekly = {
  config: {
    creditUsagePercent: 98,
    currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', start: '2026-09-21T07:00:00+00:00', end: '2026-09-28T07:00:00+00:00' },
    onDemandCap: { val: 0 },
    onDemandUsed: { val: 0 },
    prepaidBalance: { val: 0 },
    isUnifiedBillingUser: true,
    billingPeriodStart: '2026-09-21T07:00:00+00:00',
    billingPeriodEnd: '2026-09-28T07:00:00+00:00'
  },
  subscription_tier: 'SuperGrok Fixture'
}
const grokBillingFull = {
  config: {
    creditUsagePercent: 41.6,
    currentPeriod: { type: 'USAGE_PERIOD_TYPE_MONTHLY', end: '2026-10-01T00:00:00Z' },
    monthlyLimit: { val: '5000' },
    includedUsed: { val: 2080 },
    totalUsed: { val: 3314 },
    onDemandEnabled: true,
    onDemandCap: { val: 2500 },
    onDemandUsed: { val: 1234 },
    prepaidBalance: { val: 1000 },
    history: [{ month: '2026-08', totalUsed: { val: 900 } }]
  }
}
const grokSub = {
  authenticated: true,
  meta: { email: 'fixture@example.com', team_id: 'team-fixture', auth_mode: 'fixture-mode', subscription_tier: 'SuperGrok Plus Fixture', team_role: 'member' }
}
const grokWeekly = formatGrokAccount({ billing: grokBillingWeekly, subscription: grokSub }, { timeZone: 'America/New_York' })
const grokFull = formatGrokAccount({ billing: grokBillingFull, subscription: grokSub }, { timeZone: 'America/New_York' })
check('Grok account shows plan', grokWeekly.includes('Plan: SuperGrok Fixture'))
check('Grok account shows weekly credits used', grokWeekly.includes('Weekly credits used: 98%') && grokWeekly.includes('Credits left: 2%'))
check('Grok account shows reset time', /Resets: Mon, Sep 28, 3:00\sAM/.test(grokWeekly), grokWeekly)
check('Grok account says pay as you go off at zero cap', grokWeekly.includes('Pay as you go: Off'))
check('Grok account skips zero prepaid', !grokWeekly.includes('Prepaid credits'))
check('Grok account falls back to subscription tier', grokFull.includes('Plan: SuperGrok Plus Fixture'))
check('Grok account shows monthly percent', grokFull.includes('Monthly credits used: 42%') && grokFull.includes('Credits left: 58%'))
check('Grok account shows pay as you go on without an amount', grokFull.includes('Pay as you go: On') && !/Pay as you go: \$/.test(grokFull))
// Nonzero amounts in every money field; the unit is unverified, so no dollar row may print.
check(
  'Grok account hides dollar rows on a nonzero billing sample',
  !grokFull.includes('$') && !/Monthly limit|Included used|Total used|Prepaid credits|this month/.test(grokFull),
  grokFull
)
check('Grok account notes team-managed limits', grokFull.includes('Usage limits are managed by your team.'))
check('Grok account never shows identity fields', ![grokWeekly, grokFull].some((t) => /fixture@example\.com|team-fixture|fixture-mode/.test(t)))
check('Grok account never says claude.ai', ![grokWeekly, grokFull].some((t) => /claude\.ai|Claude|Cursor|Codex|ChatGPT/i.test(t)))
check('Grok account links grok.com usage', grokWeekly.includes('https://grok.com/?_s=usage'))
const grokSession = formatGrokSession(JSON.stringify({ session: { primaryModelId: 'grok-fixture', turnCount: 3, inputTokens: 1200, outputTokens: 300, costUsdTicks: 2_500_000_000 } }))
const grokText = grokUsageText({ account: grokWeekly, session: grokSession, cwd })
check('Grok session block is extra, not a replacement', grokText.startsWith('Grok account') && grokText.includes('Plan: SuperGrok Fixture') && grokText.includes('This session') && grokText.indexOf('Grok account') < grokText.indexOf('This session'))
check('Grok session block formats tokens and cost', !!grokSession && grokSession.includes('Turns: 3') && grokSession.includes('Est. cost: $2.50'))
const grokLive = await grokUsageBlurb(cwd, undefined, async () => ({ billing: grokBillingWeekly }))
check('Grok /usage without a session still shows the account', grokLive.includes('Weekly credits used: 98%') && grokLive.includes(`This folder: ${cwd}`))
const grokDown = await grokUsageBlurb(cwd, undefined, async () => {
  throw new Error('billing offline')
})
check('Grok /usage survives a billing error', grokDown.startsWith('Grok account') && grokDown.includes('Could not load the credit meter. billing offline'))
const grokNoAgent = await grokUsageBlurb(cwd, undefined, async () => ({ starting: true }))
check(
  'Grok /usage while the agent is starting says so, not an empty account',
  grokNoAgent.includes('Grok is still starting. Try /usage again in a moment.') && !grokNoAgent.includes('No billing data available.'),
  grokNoAgent
)
const meterRow = panelBlocks(grokWeekly)
  .flatMap((b) => b.rows)
  .find((r) => r.kind === 'row' && r.key === 'Weekly credits used')
check('Usage popup draws a meter for credits used', !!meterRow && meterRow.kind === 'row' && meterRow.percent === 98)
check('Usage popup keeps the account heading', panelBlocks(grokText)[0]?.heading === 'Grok account')
// Grok plan approval: a fixture `_x.ai/exit_plan_mode` request through the real handleReq, fake pool.
function fakePool() {
  const sent: { id: number | string; result?: unknown; error?: { code: number; message: string } }[] = []
  const events: { kind: string; title?: string; detail?: string; options?: { id: string; label: string }[]; mode?: string; data?: string }[] = []
  const tab = {
    tabId: 'tab-plan',
    sessionId: 'sess-plan-1',
    promptId: null,
    appTools: [],
    text: '',
    alwaysApprove: true,
    planMode: true,
    reviews: [] as { id: string; label: string; at: number }[],
    onEvent: (ev: (typeof events)[number]) => events.push(ev)
  }
  const pool = {
    kind: 'grok' as const,
    cwd,
    boot: Promise.resolve(),
    tabs: new Map([[tab.tabId, tab]]),
    bySid: new Map([[tab.sessionId, tab.tabId]]),
    rpc: {
      reply: (id: number | string, result: unknown) => sent.push({ id, result }),
      error: (id: number | string, code: number, message: string) => sent.push({ id, error: { code, message } })
    }
  }
  return { pool, tab, sent, events }
}
const planAsk = { jsonrpc: '2.0' as const, id: 41, method: '_x.ai/exit_plan_mode', params: { sessionId: 'sess-plan-1', toolCallId: 'call-1', planContent: '# Plan\n1. Add the thing\n2. Test it' } }
const approveRun = fakePool()
handleReq(approveRun.pool as never, planAsk)
const card = approveRun.events.find((e) => e.kind === 'permission')
check('exit_plan_mode is not Method not found', !approveRun.sent.some((m) => m.error?.code === -32601))
check('exit_plan_mode waits for a person even with Always approve on', approveRun.sent.length === 0)
check(
  'exit_plan_mode shows an Approve / Keep planning card with the plan',
  !!card && card.title === 'Approve this plan?' && !!card.detail?.includes('Add the thing') && card.options?.map((o) => o.label).join('|') === 'Approve|Keep planning'
)
answerPlanAsk(approveRun.pool as never, approveRun.tab as never, PLAN_APPROVE)
const approved = approveRun.sent[0]?.result as Record<string, unknown> | undefined
check('Approve answers request 41 with approved', approveRun.sent[0]?.id === 41 && approved?.approved === true && approved?.outcome === 'approved', JSON.stringify(approveRun.sent))
check(
  'Approve does not leave plan mode until Grok confirms',
  approveRun.tab.planMode === true && !approveRun.events.some((e) => e.kind === 'mode') && !winSent.some((e) => e.kind === 'mode') && !(approveRun.tab as { planAsk?: boolean }).planAsk && (approveRun.tab as { permId?: unknown }).permId == null
)
const note = (sessionId: string, update: Record<string, unknown>) => ({ jsonrpc: '2.0' as const, method: 'session/update', params: { sessionId, update } })
winSent.length = 0
handleNote(approveRun.pool as never, note('sess-plan-1', { sessionUpdate: 'current_mode_update', currentModeId: 'default' }))
check(
  'A later current_mode_update default leaves plan mode',
  approveRun.tab.planMode === false && winSent.some((e) => e.tabId === 'tab-plan' && e.kind === 'mode' && e.mode === 'default'),
  JSON.stringify(winSent)
)
winSent.length = 0
handleNote(approveRun.pool as never, note('sess-plan-1', { sessionUpdate: 'current_mode_update', currentModeId: 'plan' }))
check('A later current_mode_update plan turns plan mode back on', approveRun.tab.planMode === true && winSent.some((e) => e.kind === 'mode' && e.mode === 'plan'))
const failRun = fakePool()
handleReq(failRun.pool as never, planAsk)
answerPlanAsk(failRun.pool as never, failRun.tab as never, PLAN_APPROVE)
handleNote(
  failRun.pool as never,
  note('sess-plan-1', { sessionUpdate: 'tool_call_update', toolCallId: 'call-1', status: 'failed', title: 'exit_plan_mode', content: [{ type: 'content', content: { type: 'text', text: 'missing field `decision` FIXTURE_ERR_7' } }] })
)
const planErr = failRun.events.find((e) => e.kind === 'error') as { data?: string } | undefined
check('A failed exit_plan_mode tool update shows an error in the thread', !!planErr?.data?.includes('FIXTURE_ERR_7'), JSON.stringify(failRun.events))
check('A failed exit_plan_mode keeps plan mode on', failRun.tab.planMode === true && !failRun.events.some((e) => e.kind === 'mode'))
const byIdRun = fakePool()
handleReq(byIdRun.pool as never, planAsk)
handleNote(byIdRun.pool as never, note('sess-plan-1', { sessionUpdate: 'tool_call_update', toolCallId: 'call-1', status: 'error', rawOutput: 'FIXTURE_RAW_8' }))
check('A failed plan tool update without a title still shows (by tool call id)', byIdRun.events.some((e) => e.kind === 'error' && (e as { data?: string }).data?.includes('FIXTURE_RAW_8')))
const otherRun = fakePool()
handleNote(otherRun.pool as never, note('sess-plan-1', { sessionUpdate: 'tool_call_update', toolCallId: 'call-9', status: 'failed', title: 'run_terminal_cmd', content: 'exit 1' }))
check('A failed ordinary tool is not a chat error', !otherRun.events.some((e) => e.kind === 'error'))
const keepRun = fakePool()
handleReq(keepRun.pool as never, { ...planAsk, id: 'x-42', method: 'x.ai/exit_plan_mode' })
answerPlanAsk(keepRun.pool as never, keepRun.tab as never, PLAN_KEEP)
const kept = keepRun.sent[0]?.result as Record<string, unknown> | undefined
check('Keep planning answers with not approved and stays in plan mode', keepRun.sent[0]?.id === 'x-42' && kept?.approved === false && keepRun.tab.planMode === true, JSON.stringify(keepRun.sent))
const strayRun = fakePool()
handleReq(strayRun.pool as never, { ...planAsk, id: 43, params: { sessionId: 'unknown-session' } })
check('exit_plan_mode for an unknown session keeps planning', (strayRun.sent[0]?.result as Record<string, unknown> | undefined)?.approved === false)
const staleRun = fakePool()
handleReq(staleRun.pool as never, planAsk)
staleRun.tab.alwaysApprove = false
handleReq(staleRun.pool as never, { jsonrpc: '2.0', id: 44, method: 'session/request_permission', params: { sessionId: 'sess-plan-1', options: [{ optionId: 'allow_once', name: 'Allow' }] } })
const staleTab = staleRun.tab as { planAsk?: boolean; permId?: number | string }
check('A tool ask after an unanswered plan card is a normal permission again', staleTab.planAsk === false && staleTab.permId === 44)
const loadRun = fakePool()
winSent.length = 0
loadRun.tab.reviews = [{ id: 'call-1', label: 'Opus is reviewing', at: 1 }]
adoptLoadedSession(loadRun.pool as never, loadRun.tab as never, 'sess-loaded-2', {} as never)
check(
  'A loaded or resumed session starts outside plan mode and says so',
  loadRun.tab.planMode === false &&
    loadRun.tab.sessionId === 'sess-loaded-2' &&
    loadRun.pool.bySid.get('sess-loaded-2') === 'tab-plan' &&
    !loadRun.pool.bySid.has('sess-plan-1') &&
    winSent.some((e) => e.tabId === 'tab-plan' && e.kind === 'mode' && e.mode === 'default'),
  JSON.stringify(winSent)
)
check(
  'A loaded session drops an Opus review',
  loadRun.tab.reviews.length === 0 && loadRun.events.some((e) => e.kind === 'status' && e.data === 'bg:[]')
)
const exitRun = fakePool()
exitRun.tab.reviews = [{ id: 'call-1', label: 'Opus is reviewing', at: 1 }]
winSent.length = 0
onPoolExit(exitRun.pool as never)
check('A restarted Grok agent clears plan mode and tells the chat', exitRun.tab.planMode === false && winSent.some((e) => e.tabId === 'tab-plan' && e.kind === 'mode' && e.mode === 'default'))
check(
  'A dead Grok process drops an Opus review',
  exitRun.tab.reviews.length === 0 && exitRun.events.some((e) => e.kind === 'status' && e.data === 'bg:[]')
)
const reviewEvents: { kind: string; data?: string }[] = []
const reviewTab = {
  tabId: 'tab-review',
  sessionId: 'sess-review',
  promptId: null,
  appTools: [],
  text: '',
  reviews: [{ id: 'call-1', label: 'Opus is reviewing', at: 1 }],
  onEvent: (ev: { kind: string; data?: string }) => reviewEvents.push(ev)
}
const reviewPool = {
  kind: 'grok' as const,
  cwd,
  boot: Promise.resolve(),
  tabs: new Map([[reviewTab.tabId, reviewTab]]),
  bySid: new Map([[reviewTab.sessionId, reviewTab.tabId]]),
  rpc: {
    notify() {},
    reply() {},
    request: () => Promise.resolve({}),
    kill() {}
  }
}
attachPool('review-check', reviewPool as never)
check(
  'Stop clears an Opus review and tells the chat',
  acpCancel('tab-review') && reviewTab.reviews.length === 0 && reviewEvents.some((e) => e.kind === 'status' && e.data === 'bg:[]')
)
reviewTab.reviews = [{ id: 'call-2', label: 'Opus is reviewing', at: 2 }]
reviewEvents.length = 0
acpClose('tab-review')
check(
  'Close clears an Opus review and tells the chat',
  reviewTab.reviews.length === 0 && reviewEvents.some((e) => e.kind === 'status' && e.data === 'bg:[]')
)
detachPool('review-check')
const acpSrc = readFileSync(join(rootRepo, 'src/main/acp-session.ts'), 'utf8')
const fnBody = (name: string) => acpSrc.slice(acpSrc.indexOf(`export async function ${name}(`), acpSrc.indexOf('\nexport ', acpSrc.indexOf(`export async function ${name}(`) + 1))
const warmBody = fnBody('acpWarm')
const exitAt = acpSrc.indexOf("proc.on('exit'")
check(
  'acpResume, both session/load paths in acpWarm, and the pool exit handler use the shared plan reset',
  /adoptLoadedSession\(/.test(fnBody('acpResume')) &&
    (warmBody.match(/adoptLoadedSession\(/g) || []).length >= 2 &&
    !/clearPlanState\(/.test(warmBody + fnBody('acpResume')) &&
    exitAt > 0 &&
    /onPoolExit\(pool\)/.test(acpSrc.slice(exitAt, exitAt + 200))
)
// Claude plan mode: a control_response after the 4s wait still applies (claude-plan helper, as handleClaude calls it).
const claudeTabs = new Set<string>()
const cc = newPlanControls()
cc.pending.set('mode-1', () => {})
controlTimedOut(cc, 'mode-1', { tabId: 'c-tab', on: true })
const lateOn = controlAnswered(cc, 'mode-1', true, claudeTabs)
check('Claude late plan-on confirm turns plan mode on', lateOn.kind === 'late' && lateOn.on && lateOn.ok && claudeTabs.has('c-tab'), JSON.stringify(lateOn))
cc.pending.set('mode-2', () => {})
controlTimedOut(cc, 'mode-2', { tabId: 'c-tab', on: false })
const lateOff = controlAnswered(cc, 'mode-2', true, claudeTabs)
check('Claude late plan-off confirm turns plan mode off', lateOff.kind === 'late' && !lateOff.on && !claudeTabs.has('c-tab'), JSON.stringify(lateOff))
claudeTabs.add('c-tab')
cc.pending.set('mode-3', () => {})
controlTimedOut(cc, 'mode-3', { tabId: 'c-tab', on: false })
const lateFail = controlAnswered(cc, 'mode-3', false, claudeTabs)
check('Claude late refusal leaves plan mode as it was', lateFail.kind === 'late' && !lateFail.ok && claudeTabs.has('c-tab'))
let resolvedWith: boolean | null = null
cc.pending.set('mode-4', (ok) => (resolvedWith = ok))
const onTime = controlAnswered(cc, 'mode-4', true, claudeTabs)
check('Claude on-time confirm still resolves the waiting call', onTime.kind === 'pending' && resolvedWith === true && !controlTimedOut(cc, 'mode-4', { tabId: 'c-tab', on: true }))
const claudeSrc = readFileSync(join(rootRepo, 'src/main/claude-stream.ts'), 'utf8')
check('handleClaude and claudePlanMode use the late-confirm helper', /controlAnswered\(/.test(claudeSrc) && /controlTimedOut\(/.test(claudeSrc) && /emitChat\(/.test(claudeSrc))
const twSrc = readFileSync(join(rootRepo, 'src/renderer/src/TerminalWorkspace.tsx'), 'utf8')
check('Chat paints Claude mode events on the plan strip too', /kindRef\.current === 'grok' \|\| kindRef\.current === 'claude'\) \{\s*showPlanRef\.current/.test(twSrc))

check('App lane owns /plan, /permissions, /status', ['plan', 'view-plan', 'permissions', 'status'].every((n) => APP_SLASH.has(n)))

const pass = results.every((r) => r.ok)
const out = [
  ...results.map((r) => `${r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.ok || !r.detail ? '' : `  ${r.detail}`}`),
  '',
  '--- /save prompt (head) ---',
  (save?.prompt || '').slice(0, 900),
  '',
  '--- Codex usage fixture ---',
  codexText,
  '',
  '--- Claude usage fixture ---',
  claudeText,
  '',
  claudeLive,
  '',
  '--- Grok usage fixture ---',
  grokText,
  '',
  grokFull,
  '',
  pass ? 'SLASH_SKILLS_PASS' : 'SLASH_SKILLS_FAIL'
].join('\n')
writeFileSync(join(temp, 'out.txt'), out)
console.log(out)
console.log(`\nartifact: ${join(temp, 'out.txt')}`)
process.exit(pass ? 0 : 1)
