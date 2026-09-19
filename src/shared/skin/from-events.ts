import { actionRisk, type SkinComponentId } from './catalog'
import type { SkinAction, SkinInEvent, SkinSpec } from './spec'

let seq = 0
function nid(prefix: string): string {
  seq += 1
  return prefix + '-' + seq
}

function act(id: SkinAction['id'], label: string): SkinAction {
  return { id, label, risk: actionRisk(id) }
}

export function specFromStreamEvent(ev: SkinInEvent): SkinSpec | null {
  if (ev.kind === 'thought' && ev.data) {
    return { id: nid('thought'), component: 'Thought', props: { text: ev.data }, actions: [], source: 'thought' }
  }
  if (ev.kind === 'text' && ev.data) {
    return {
      id: nid('agent'),
      component: 'AgentMessage',
      props: { text: ev.data },
      actions: [],
      source: 'text'
    }
  }
  if (ev.kind === 'file' && ev.path) {
    return {
      id: nid('tool'),
      component: 'ToolCard',
      props: { path: ev.path, tool: ev.tool || 'file' },
      actions: [],
      source: 'file'
    }
  }
  if (ev.kind === 'status' && ev.data === 'compacting') {
    return {
      id: nid('compact'),
      component: 'CompactNotice',
      props: { phase: 'compacting' },
      actions: [],
      source: 'status'
    }
  }
  if (ev.kind === 'status' && ev.data === 'compacted') {
    return {
      id: nid('compacted'),
      component: 'CompactNotice',
      props: { phase: 'compacted' },
      actions: [],
      source: 'status'
    }
  }
  if (ev.kind === 'status' && ev.data) {
    const label = ev.data.startsWith('work:') ? ev.data.slice(5) : ev.data
    return {
      id: nid('work'),
      component: 'WorkPulse',
      props: { label },
      actions: [act('stop', 'Stop')],
      source: 'status'
    }
  }
  if (ev.kind === 'context') {
    return {
      id: nid('ctx'),
      component: 'ContextMeter',
      props: { used: ev.used, total: ev.total, percent: ev.percent },
      actions: [],
      source: 'context'
    }
  }
  if (ev.kind === 'commands' && ev.commands?.length) {
    return {
      id: nid('slash'),
      component: 'SlashMenu',
      props: { commands: ev.commands },
      actions: [act('runSlash', 'Run')],
      source: 'commands'
    }
  }
  if (ev.kind === 'error' && ev.data) {
    const login = /sign in|not logged|login|auth/i.test(ev.data)
    const component: SkinComponentId = login ? 'LoginNeed' : 'ErrorNotice'
    return {
      id: nid('err'),
      component,
      props: { text: ev.data },
      actions: login ? [act('login', 'Sign in')] : [],
      source: 'error'
    }
  }
  if (ev.kind === 'permission') {
    return {
      id: nid('perm'),
      component: 'PermissionAsk',
      props: {
        title: ev.title || 'Allow this?',
        path: ev.path || '',
        options: ev.options || [],
        requestId: ev.requestId || ''
      },
      actions: [
        act('allowOnce', 'Allow'),
        act('skip', 'Skip'),
        act('alwaysAllowInFolder', 'Always in this folder')
      ],
      source: 'permission'
    }
  }
  if (ev.kind === 'plan' && ev.steps?.length) {
    return {
      id: nid('plan'),
      component: 'Plan',
      props: { steps: ev.steps },
      actions: [],
      source: 'plan'
    }
  }
  if (ev.kind === 'done') return null
  return {
    id: nid('raw'),
    component: 'RawFallback',
    props: { kind: ev.kind, data: ev.data || '' },
    actions: [act('openRaw', 'Open raw')],
    source: ev.kind || 'unknown'
  }
}

export function userMessageSpec(text: string): SkinSpec {
  return {
    id: nid('user'),
    component: 'UserMessage',
    props: { text },
    actions: [],
    source: 'send'
  }
}

export function queueSpec(items: { text: string }[]): SkinSpec | null {
  if (!items.length) return null
  return {
    id: nid('queue'),
    component: 'Queue',
    props: { items: items.map((i) => i.text) },
    actions: [act('stop', 'Stop')],
    source: 'queue'
  }
}

export function catalogIdForEvent(ev: SkinInEvent): SkinComponentId | null {
  const spec = specFromStreamEvent(ev)
  if (!spec || spec.component === 'RawFallback') return null
  return spec.component
}
