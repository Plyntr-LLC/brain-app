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
    if (url === 'stub:electron') return { format: 'module', shortCircuit: true, source: 'export const app = {}; export default { app }' }
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
const { formatClaudeStats, formatClaudeUsage } = (await import(src('claude-usage.ts'))) as typeof import('../src/main/claude-usage.ts')

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
  pass ? 'SLASH_SKILLS_PASS' : 'SLASH_SKILLS_FAIL'
].join('\n')
writeFileSync(join(temp, 'out.txt'), out)
console.log(out)
console.log(`\nartifact: ${join(temp, 'out.txt')}`)
process.exit(pass ? 0 : 1)
