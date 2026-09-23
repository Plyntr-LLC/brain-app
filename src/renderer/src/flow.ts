import { OWNER_NEEDS, STEPS, TEAM_NEED, type NeedId, type PathKind, type Session } from '@shared/contracts'

export function blankSession(path: PathKind, dryRun: boolean): Session {
  return {
    path,
    screen: 'fork',
    email: '',
    teams: [],
    business: path === 'join' || path === 'second' ? "Harold's Books" : '',
    abWatching: false,
    dryRun,
    filled: path === 'second' ? Object.fromEntries(OWNER_NEEDS.map((n) => [n.id, true])) : {},
    parked: []
  }
}

const settingUpNewBrain = ['plyntr-code', 'plyntr-project', 'plyntr-create']

export function stepState(s: Session, id: (typeof STEPS)[number]['id']): 'now' | 'done' | 'blocked' | '' {
  if (id === 'signed') {
    if (s.screen === 'plyntr-create') return 'done'
    if (['fork', 'welcome', 'email', 'otp', 'plyntr-code', 'plyntr-project'].includes(s.screen)) return 'now'
    return 'done'
  }
  if (id === 'ab') {
    if (settingUpNewBrain.includes(s.screen)) return 'now'
    if (s.abWatching || s.brainPath) return 'done'
    if (['abget', 'github', 'abapply', 'hello', 'choice', 'name', 'needs'].includes(s.screen)) return 'now'
    return s.email && s.screen !== 'email' && s.screen !== 'code' ? 'now' : ''
  }
  if (id === 'ai') {
    if (settingUpNewBrain.includes(s.screen)) return ''
    if (s.screen === 'chat') return 'done'
    if (s.screen === 'aipick' || s.screen === 'aiwork') return 'now'
    return s.abWatching || s.brainPath ? 'now' : ''
  }
  if (id === 'know') {
    if (s.screen === 'chat') return 'now'
    return ''
  }
  return ''
}

export function needsDone(s: Session): boolean {
  if (s.path === 'join') return !!s.filled.you
  if (s.path === 'second') return true
  return OWNER_NEEDS.every((n) => s.filled[n.id])
}

export function remainingNeeds(s: Session) {
  if (s.path === 'join') return s.filled.you ? [] : [TEAM_NEED]
  if (s.path === 'second') return []
  return OWNER_NEEDS.filter((n) => !s.filled[n.id])
}

export function fillFromText(s: Session, text: string): Partial<Record<NeedId, boolean>> {
  const next = { ...s.filled }
  const t = text
  if (s.path === 'join') {
    if (t.trim().length > 12) next.you = true
    return next
  }
  const tests: [NeedId, RegExp][] = [
    ['what', /book|shed|gutter|we |i run|business|help |account|ministr|shop|garage|puppy/i],
    ['who', /customer|client|who |serve|owner|homeowner|breeder|people who/i],
    ['offer', /sell|price|fee|\$|service|charge|retainer|hourly/i],
    ['voice', /plain|tone|sound|voice|friendly|direct|professional|casual|honest/i],
    ['now', /month|week|priority|right now|matter|goal|this quarter/i],
    ['people', /team|we have|employee|just me|solo|staff|scout|bookkeeper/i]
  ]
  for (const [id, re] of tests) if (!next[id] && re.test(t)) next[id] = true
  if (t.length > 180) {
    for (const id of ['what', 'who', 'offer'] as NeedId[]) next[id] = true
  }
  return next
}
