// Mockup E's style rules (plans/mockups/20261006-factory/base.css), checked against computed styles in a page.
// styleRules is self-contained so scripts/style-audit.ts can send its source over the DevTools protocol and the
// render pages can call it directly. Each rule returns violations; an empty list passes.

export type Violation = { rule: string; at: string; detail: string }
export type RuleSet = 'ui' | 'chrome' | 'session' | 'picker' | 'strip' | 'dark' | 'inventory' | 'composer'

export function styleRules(which: RuleSet): Violation[] | Record<string, string> | Promise<Violation[]> {
  const out: Violation[] = []
  const rootCs = getComputedStyle(document.documentElement)
  const hex = (h: string) => {
    const s = h.trim().replace('#', '')
    return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16))
  }
  const rgb = (s: string) => {
    const m = String(s).match(/[\d.]+/g)
    if (!m) return null
    const n = m.slice(0, 4).map(Number)
    // color(srgb r g b) reports 0..1 channels.
    return String(s).startsWith('color(') ? [n[0] * 255, n[1] * 255, n[2] * 255, n[3] ?? 1] : n
  }
  const dist = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
  const alpha = (c: number[] | null) => (c && c.length === 4 ? c[3] : 1)
  const ink = hex(rootCs.getPropertyValue('--ink'))
  const line = hex(rootCs.getPropertyValue('--line'))
  const orange = hex(rootCs.getPropertyValue('--orange'))
  const short = (el: Element) => (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40)
  const path = (el: Element) => {
    const bits: string[] = []
    for (let e: Element | null = el; e && e !== document.body && bits.length < 4; e = e.parentElement) {
      const cls = typeof e.className === 'string' ? e.className.trim().split(/\s+/).filter(Boolean).slice(0, 2).join('.') : ''
      bits.unshift(e.tagName.toLowerCase() + (cls ? '.' + cls : ''))
    }
    return bits.join(' > ')
  }
  const add = (rule: string, el: Element | string, detail: string) => out.push({ rule, at: typeof el === 'string' ? el : path(el), detail })
  const shown = (el: Element) => {
    const r = el.getBoundingClientRect()
    if (r.width < 1 || r.height < 1 || r.bottom <= 0 || r.right <= 0 || r.top >= innerHeight || r.left >= innerWidth) return false
    for (let e: Element | null = el; e; e = e.parentElement) {
      const cs = getComputedStyle(e)
      if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) return false
    }
    return true
  }
  const inside = (r: DOMRect, box: { top: number; left: number; bottom: number; right: number }) =>
    r.width > 0 && r.height > 0 && r.top >= box.top - 0.5 && r.left >= box.left - 0.5 && r.bottom <= box.bottom + 0.5 && r.right <= box.right + 0.5
  const viewport = { top: 0, left: 0, bottom: innerHeight, right: innerWidth }
  const ownText = (el: Element) => [...el.childNodes].some((n) => n.nodeType === 3 && (n.textContent || '').trim())
  const face = (ff: string) => ff.split(',')[0].replace(/["']/g, '').trim().toLowerCase()
  const serif = (ff: string) => face(ff) === 'source serif 4' || face(ff) === 'georgia' || face(ff) === 'serif'
  const PROSE = '.mdbody, .think-body, .mdview'
  const HEADINGS = '.settings h1, .settings h2, [data-setup-screen] h1, [data-setup-screen] h2, .mdbody h1, .mdbody h2, .mdbody h3, .mdview h1, .mdview h2, .mdview h3'
  const UNBOXED = '.linkish, .tabname, .tabx, .tabadd, .think-label, .flink, .away-line, .away-head, .rail-fold, .rail-more, .runmeta-v, .runpick button, .slashmenu button, .modes button, .folderpick, .set-fold'
  const SELECTED = '.runpick button.on, .slashmenu button.on, .modes button.on'
  const boxed = (cs: CSSStyleDeclaration) => {
    const bc = rgb(cs.borderTopColor)
    const bg = rgb(cs.backgroundColor)
    return {
      bordered: parseFloat(cs.borderTopWidth) > 0 && cs.borderTopStyle !== 'none' && alpha(bc) > 0,
      filled: !!bg && alpha(bg) > 0.05,
      bc,
      bg
    }
  }
  const all = () => [...document.querySelectorAll('body *')].filter((el) => !el.closest('.xterm, svg, webview, #out') && shown(el))

  if (which === 'ui') {
    for (const el of all()) {
      const cs = getComputedStyle(el)
      const fs = parseFloat(cs.fontSize)
      if (ownText(el)) {
        if (serif(cs.fontFamily) && !el.closest(PROSE)) add('serif-ui', el, `${face(cs.fontFamily)} "${short(el)}"`)
        if (fs > 15.01 && !el.closest(PROSE) && !el.matches(HEADINGS)) add('ui-text-over-15px', el, `${fs}px "${short(el)}"`)
      }
      if (el.matches('.mdbody p, .mdbody li, .think-body p, .mdview p') && ownText(el) && !serif(cs.fontFamily)) add('prose-lost-serif', el, `${face(cs.fontFamily)} "${short(el)}"`)
      if (el.matches('.skin-row .bubble.md .mdbody') && (Math.abs(fs - 14.5) > 0.3 || Math.abs(parseFloat(cs.lineHeight) / fs - 1.55) > 0.03)) add('answer-size', el, `${fs}px / ${cs.lineHeight}`)
      if (el.matches(UNBOXED)) {
        const b = boxed(cs)
        // A selected row keeps its fill but never a border.
        if (b.bordered || (b.filled && !el.matches(SELECTED))) add('row-control-boxed', el, `"${short(el)}" border ${cs.borderTopWidth} bg ${cs.backgroundColor}`)
      } else if (el.tagName === 'BUTTON' || el.matches('a.dl')) {
        const b = boxed(cs)
        if (b.bordered || b.filled) {
          const rad = parseFloat(cs.borderTopLeftRadius)
          if (rad < 5.99) add('button-radius-under-6', el, `${rad}px "${short(el)}"`)
          if (fs > 13.01) add('button-text-over-13px', el, `${fs}px "${short(el)}"`)
          const solid = b.filled && b.bg && b.bc && dist(b.bg, b.bc) < 8
          if (b.bordered && !solid && b.bc && dist(b.bc, ink) < dist(b.bc, line)) add('button-border-near-ink', el, `${cs.borderTopColor} "${short(el)}"`)
        }
      }
      const field = (el.tagName === 'INPUT' && !['checkbox', 'radio', 'range', 'file', 'hidden'].includes((el as HTMLInputElement).type)) || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA'
      if (field) {
        if (parseFloat(cs.borderTopWidth) > 0 && parseFloat(cs.borderTopLeftRadius) < 7.99) add('input-radius-under-8', el, cs.borderTopLeftRadius)
        if (serif(cs.fontFamily)) add('serif-input', el, face(cs.fontFamily))
        if (fs > 13.51) add('input-text-over-13.5px', el, `${fs}px`)
      }
    }
    return out
  }

  if (which === 'chrome') {
    if (!document.documentElement.classList.contains('glass')) add('no-glass', 'html', 'html.glass missing: chrome is not measured under the Mac overrides')
    const tb = document.querySelector('.titlebar')
    const bar = document.querySelector('.tabbar')
    if (!tb || Math.abs(tb.getBoundingClientRect().height - 40) > 1) add('titlebar-height', '.titlebar', String(tb?.getBoundingClientRect().height))
    if (!bar || Math.abs(bar.getBoundingClientRect().height - 36) > 1) add('tabbar-height', '.tabbar', String(bar?.getBoundingClientRect().height))
    const on = document.querySelector('.tab.on')
    if (on) {
      const cs = getComputedStyle(on)
      const shadow = cs.boxShadow
      const colors = (shadow.match(/rgba?\([^)]*\)/g) || []).map((c) => rgb(c) || [0, 0, 0])
      const underline = /-2px/.test(shadow) && colors.some((c) => dist(c, orange) < 12)
      const border = parseFloat(cs.borderBottomWidth) >= 2 && dist(rgb(cs.borderBottomColor) || [0, 0, 0], orange) < 12
      if (!underline && !border) add('active-tab-underline', on, `box-shadow ${shadow}; border-bottom ${cs.borderBottomWidth} ${cs.borderBottomColor}`)
    } else add('active-tab-missing', '.tab.on', 'no active tab')
    const plus = document.querySelector('.tabadd')
    if (plus && parseFloat(getComputedStyle(plus).fontSize) > 13.01) add('plus-size', plus, getComputedStyle(plus).fontSize)
    return out
  }

  if (which === 'session') {
    const meta = document.querySelector('.runmeta')
    if (!meta || !shown(meta)) return [{ rule: 'session-missing', at: '.runmeta', detail: 'no Session card on screen' }]
    const box = (meta.closest('.refs') || document.body).getBoundingClientRect()
    const within = { top: Math.max(0, box.top), left: Math.max(0, box.left), bottom: Math.min(innerHeight, box.bottom), right: Math.min(innerWidth, box.right) }
    const label = meta.querySelector('h5')
    if (!label || (label.textContent || '').trim().toLowerCase() !== 'session') add('session-label', '.runmeta h5', label ? short(label) : 'none')
    if (parseFloat(getComputedStyle(meta).borderTopLeftRadius) < 7.99) add('session-not-a-card', meta, getComputedStyle(meta).borderTopLeftRadius)
    if (!inside(meta.getBoundingClientRect(), within)) add('session-clipped', meta, JSON.stringify(meta.getBoundingClientRect()))
    const keys = [...meta.querySelectorAll('.runmeta-k')]
    const muted = hex(rootCs.getPropertyValue('--muted'))
    for (const k of keys) {
      const v = k.nextElementSibling
      if (!v || !v.classList.contains('runmeta-v')) continue
      const kc = getComputedStyle(k)
      const vc = getComputedStyle(v)
      if (Math.abs(k.getBoundingClientRect().top - v.getBoundingClientRect().top) > 4) add('session-not-a-grid-row', k, `${short(k)}: label top ${Math.round(k.getBoundingClientRect().top)} value top ${Math.round(v.getBoundingClientRect().top)}`)
      if (Math.abs(parseFloat(vc.fontSize) - 12) > 0.5 || Number(vc.fontWeight) !== 600) add('session-value-type', v, `${short(k)}: ${vc.fontSize} ${vc.fontWeight}`)
      if (Math.abs(parseFloat(kc.fontSize) - 12) > 0.5 || dist(rgb(kc.color) || [0, 0, 0], muted) > 12) add('session-label-type', k, `${short(k)}: ${kc.fontSize} ${kc.color}`)
    }
    for (const want of ['Model', 'Effort']) {
      const k = keys.find((x) => (x.textContent || '').trim() === want)
      const v = k?.nextElementSibling
      if (!v || v.tagName !== 'BUTTON') add(`session-${want.toLowerCase()}-missing`, meta, `no ${want} button`)
      else if (!inside(v.getBoundingClientRect(), within)) add(`session-${want.toLowerCase()}-clipped`, v, JSON.stringify(v.getBoundingClientRect()))
    }
    return out
  }

  if (which === 'picker') {
    const pick = document.querySelector('.runpick')
    if (!pick) return [{ rule: 'model-picker-missing', at: '.runpick', detail: 'clicking Model opened nothing' }]
    const first = pick.querySelector('button')
    if (!first) return [{ rule: 'model-picker-empty', at: '.runpick', detail: short(pick) }]
    const r = first.getBoundingClientRect()
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
    if (!hit || !(hit === first || first.contains(hit))) add('model-picker-clipped', first, `center hits ${hit ? path(hit) : 'nothing'}`)
    return out
  }

  if (which === 'strip') {
    const pane = document.querySelector('.chatpane.on')
    const skin = pane?.querySelector('.skin-pane:not(.peel):not(.hide)')
    const thread = skin?.querySelector('.skin-thread')
    const composer = pane?.querySelector('.composer')
    if (!thread || !composer) return out
    const tr = thread.getBoundingClientRect()
    const top = Math.floor(tr.bottom) - 1
    const bottom = Math.ceil(composer.getBoundingClientRect().top) + 1
    for (let y = top; y <= bottom; y++) {
      for (const x of [tr.left + 20, tr.left + tr.width / 2, tr.right - 30]) {
        const hit = document.elementFromPoint(x, y)
        if (hit && hit.closest('.skin-term')) {
          add('skin-terminal-strip', '.skin-term', `the terminal shows at y=${y} (thread ends ${Math.round(tr.bottom)}, composer starts ${Math.round(composer.getBoundingClientRect().top)})`)
          return out
        }
      }
    }
    return out
  }

  if (which === 'dark') {
    const lights = ['#f3eee8', '#fffdf9', '#efe8df', '#d9d0c6', '#e6ddd2'].map(hex)
    // Dark ink (#f4efe8) sits next to light paper; an ink-filled button is meant to be light in dark.
    const near = (c: number[] | null) => !!c && alpha(c) > 0.3 && dist(c, ink) >= 6 && lights.some((l) => dist(l, c) < 6)
    for (const el of all()) {
      if (el.closest('img, video, .who')) continue
      const cs = getComputedStyle(el)
      if (near(rgb(cs.backgroundColor))) add('dark-light-background', el, cs.backgroundColor)
      else if (parseFloat(cs.borderTopWidth) > 0 && cs.borderTopStyle !== 'none' && near(rgb(cs.borderTopColor))) add('dark-light-border', el, cs.borderTopColor)
    }
    return out
  }

  if (which === 'inventory') {
    const inv: Record<string, string> = {}
    const where = (el: Element | null | undefined, parents: string) => (el ? (el.closest(parents) ? parents : `elsewhere: ${path(el)}`) : 'missing')
    const btn = (scope: string, text: string) => [...document.querySelectorAll(`${scope} button`)].find((b) => (b.textContent || '').trim() === text || b.getAttribute('aria-label') === text)
    inv['Log out'] = where(btn('.titlebar', 'Log out'), '.titlebar')
    inv['Settings'] = where(btn('.titlebar', 'Settings'), '.titlebar')
    inv['theme icon'] = where(document.querySelector('.titlebar .title-icon'), '.titlebar')
    inv['sync pill'] = where(document.querySelector('.titlebar .sync-pill'), '.titlebar')
    const edges = [...document.querySelectorAll('.tabbar .edgebtn')].map((b) => (b.textContent || '').trim()).join(' ')
    inv['edge buttons'] = edges || 'missing'
    inv['+'] = where(document.querySelector('.tabbar .tabadd'), '.tabbar')
    const tabs = document.querySelectorAll('.tabbar .tab').length
    const xs = document.querySelectorAll('.tabbar .tab .tabx').length
    inv['tab ×'] = tabs && xs === tabs ? 'one per tab' : `${xs} of ${tabs}`
    const meta = document.querySelector('.runmeta')
    for (const k of ['Model', 'Effort', 'Speed', 'Mode', 'Context', 'Folder', 'Times']) {
      const label = meta ? [...meta.querySelectorAll('.runmeta-k')].find((x) => (x.textContent || '').trim() === k) : null
      if (label) inv[k] = where(label, '.runmeta')
    }
    return inv
  }

  if (which === 'composer') {
    return (async () => {
      const box = document.querySelector<HTMLTextAreaElement>('.chatpane.on .composer textarea')
      if (!box) return [{ rule: 'composer-missing', at: '.chatpane.on .composer textarea', detail: 'no composer' }]
      const set = (v: string) => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box, v)
        box.dispatchEvent(new Event('input', { bubbles: true }))
      }
      const keep = box.value
      set('')
      await new Promise((r) => setTimeout(r, 80))
      const idle = box.clientHeight
      set('one\ntwo\nthree\nfour')
      await new Promise((r) => setTimeout(r, 80))
      const grown = box.clientHeight
      set(keep)
      if (idle < 34 || idle > 48) add('composer-idle-height', box, `${idle}px`)
      if (grown < idle + 30) add('composer-does-not-grow', box, `idle ${idle}px, four lines ${grown}px`)
      return out
    })()
  }
  return out
}
