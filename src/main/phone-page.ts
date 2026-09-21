export function phonePageHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <meta name="referrer" content="no-referrer" />
  <meta name="apple-mobile-web-app-capable" content="yes" />
  <meta name="apple-mobile-web-app-title" content="Brain" />
  <title>Brain</title>
  <style>
    @font-face {
      font-family: "Schibsted Grotesk";
      src: url("/font/schibsted.woff2") format("woff2");
      font-weight: 500 700;
      font-display: swap;
    }
    @font-face {
      font-family: "Source Serif 4";
      src: url("/font/source-serif.woff2") format("woff2");
      font-weight: 400 600;
      font-display: swap;
    }
    :root {
      --ink: #1a1612;
      --muted: #5c534a;
      --line: #d9d0c6;
      --paper: #f3eee8;
      --card: #fffdf9;
      --orange-deep: #c45f00;
      --orange: #e07020;
      --ok: #2c6e3a;
      --warn: #8a5a12;
      --warn-bg: #f8eedc;
    }
    * { box-sizing: border-box; }
    html, body {
      height: 100%;
      margin: 0;
      overflow: hidden;
      position: fixed;
      width: 100%;
      background: var(--card);
      color: var(--ink);
      font-family: "Source Serif 4", Georgia, serif;
      font-size: 16px;
      line-height: 1.45;
    }
    h1, button, label, select, .kicker, .think-label { font-family: "Schibsted Grotesk", sans-serif; }
    .app {
      position: fixed;
      left: 0;
      right: 0;
      top: 0;
      height: 100%;
      display: grid;
      grid-template-rows: auto auto minmax(0, 1fr) auto;
      overflow: hidden;
      padding: env(safe-area-inset-top) 0 env(safe-area-inset-bottom);
    }
    header, footer { flex-shrink: 0; }
    header, footer { padding: 0.7rem 1rem; }
    header { grid-row: 1; border-bottom: 1px solid var(--line); background: #efe8df; }
    #banner { grid-row: 2; }
    .thread { grid-row: 3; }
    footer { grid-row: 4; }
    footer {
      border-top: 1px solid var(--line);
      background: var(--card);
      display: grid;
      grid-template-columns: 1fr auto auto auto;
      gap: 0.45rem;
      align-items: end;
    }
    h1 { font-size: 1.05rem; margin: 0 0 0.2rem; letter-spacing: -0.02em; }
    .kicker { color: var(--orange-deep); font-size: 0.72rem; font-weight: 700; margin: 0 0 0.15rem; }
    .tiny { color: var(--muted); font-size: 0.82rem; margin: 0; }
    .note {
      background: var(--warn-bg);
      color: var(--warn);
      padding: 0.65rem 0.75rem;
      margin: 0;
      font-size: 0.95rem;
    }
    .note.hidden {
      visibility: hidden;
      height: 0;
      padding: 0;
      overflow: hidden;
      pointer-events: none;
    }
    .tabrow { display: grid; grid-template-columns: 1fr; gap: 0.35rem; margin-top: 0.45rem; }
    .tabtools { display: grid; grid-template-columns: 1fr auto auto; gap: 0.35rem; }
    .tablist { display: flex; flex-wrap: wrap; gap: 0.35rem; min-height: 2.4rem; align-items: center; }
    .tabchip {
      font-size: 0.88rem;
      padding: 0.4rem 0.65rem;
      background: #fff;
      color: var(--ink);
      border: 1px solid var(--line);
    }
    .tabchip.on { background: var(--ink); color: #fff; border-color: var(--ink); }
    .pairbox { display: flex; gap: 0.35rem; margin-top: 0.45rem; }
    .pairbox.hidden { display: none; }
    #pin { width: 7rem; padding: 0.4rem 0.5rem; border: 1px solid var(--line); letter-spacing: 0.2em; font-size: 1.05rem; }
    select { width: 100%; padding: 0.4rem 0.5rem; border: 1px solid var(--line); background: #fff; color: var(--ink); }
    .thread {
      min-height: 0;
      overflow-y: auto;
      -webkit-overflow-scrolling: touch;
      padding: 0.85rem 1rem 1rem;
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
    }
    .bubble {
      max-width: 92%;
      padding: 0.7rem 0.85rem;
      border-radius: 2px;
      background: var(--paper);
      border: 1px solid var(--line);
    }
    .bubble.me { align-self: flex-end; background: #fff; border-color: #cfc4b6; }
    .bubble.md { max-width: min(46rem, 100%); }
    .bubble.md .mdbody > :last-child { margin-bottom: 0; }
    .bubble.md p { margin: 0 0 0.55rem; }
    .bubble.md ul, .bubble.md ol { margin: 0 0 0.55rem; padding-left: 1.2rem; }
    .bubble.md h1, .bubble.md h2, .bubble.md h3 {
      font-family: "Schibsted Grotesk", sans-serif;
      margin: 0 0 0.4rem;
      line-height: 1.2;
    }
    .bubble.md h1 { font-size: 1.15rem; }
    .bubble.md h2 { font-size: 1.05rem; }
    .bubble.md h3 { font-size: 0.95rem; }
    .bubble.think { color: var(--muted); font-size: 0.9rem; max-width: 40rem; }
    .think-label {
      font-size: 0.72rem;
      font-weight: 600;
      margin-bottom: 0.25rem;
      color: var(--orange-deep);
      display: block;
      width: 100%;
      text-align: left;
      border: 0;
      background: transparent;
      padding: 0;
      cursor: pointer;
    }
    .think-body { max-height: 14rem; overflow: auto; }
    .mdtable { overflow-x: auto; margin: 0.4rem 0 0.65rem; }
    .mdtable table { border-collapse: collapse; width: 100%; font-size: 0.92rem; }
    .mdtable th, .mdtable td { border: 1px solid var(--line); padding: 0.28rem 0.4rem; }
    .mdtable th { background: var(--paper); font-family: "Schibsted Grotesk", sans-serif; }
    .mdcode, .mdview pre { background: var(--paper); padding: 0.7rem; overflow: auto; font-size: 0.85rem; }
    .bubble code {
      font-family: ui-monospace, Menlo, Monaco, monospace;
      font-size: 0.88em;
      background: var(--paper);
      padding: 0.05rem 0.25rem;
      border-radius: 2px;
    }
    .bubble strong { font-weight: 700; }
    .skin-tool {
      font-family: "Schibsted Grotesk", sans-serif;
      font-size: 0.78rem;
      color: var(--muted);
      display: flex;
      gap: 0.4rem;
    }
    .skin-tool .k { font-weight: 700; color: var(--orange-deep); }
    .pulse { font-family: "Schibsted Grotesk", sans-serif; font-size: 0.82rem; color: var(--muted); }
    .followq { grid-column: 1 / -1; display: flex; flex-direction: column; gap: 0.35rem; }
    .followq-row {
      display: grid;
      grid-template-columns: 1fr auto auto auto;
      gap: 0.4rem;
      align-items: center;
      font-size: 0.9rem;
    }
    .followq-row span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .attachrow { grid-column: 1 / -1; display: flex; flex-wrap: wrap; gap: 0.35rem; }
    .chip {
      display: inline-flex;
      align-items: center;
      gap: 0.25rem;
      font-size: 0.78rem;
      font-weight: 600;
      font-family: "Schibsted Grotesk", sans-serif;
      background: var(--paper);
      border: 1px solid var(--line);
      padding: 0.15rem 0.3rem 0.15rem 0.45rem;
    }
    textarea {
      font-family: "Source Serif 4", Georgia, serif;
      font-size: 1.05rem;
      padding: 0.5rem 0.6rem;
      border: 1px solid var(--line);
      width: 100%;
      min-height: 2.8rem;
      max-height: 8rem;
      resize: vertical;
      background: #fff;
      color: var(--ink);
      grid-column: 1 / -1;
    }
    button {
      font-weight: 600;
      font-size: 0.95rem;
      padding: 0.55rem 0.75rem;
      border-radius: 2px;
      cursor: pointer;
      background: var(--ink);
      color: #fff;
      border: 1px solid var(--ink);
    }
    button:disabled { opacity: 0.4; }
    button.ghost { background: transparent; color: var(--ink); }
    button.linkish {
      background: transparent;
      border: 0;
      color: var(--orange-deep);
      padding: 0;
      font-size: 0.78rem;
    }
    #file { position: absolute; width: 1px; height: 1px; opacity: 0; overflow: hidden; }
  </style>
</head>
<body>
  <div class="app" id="app">
    <header>
      <p class="kicker">Brain</p>
      <h1 id="title">This Mac</h1>
      <p class="tiny">Plug the computer in. Closing the lid on battery will sleep.</p>
      <div class="tabrow">
        <div id="tabs" class="tablist" role="listbox" aria-label="Open chats"></div>
        <div class="tabtools">
          <select id="kind" aria-label="CLI">
            <option value="grok">Grok</option>
            <option value="claude">Claude</option>
            <option value="cursor">Cursor</option>
            <option value="gpt">ChatGPT</option>
          </select>
          <button type="button" id="new" class="ghost">New</button>
          <button type="button" id="close" class="ghost">Close</button>
        </div>
      </div>
      <div id="pairbox" class="pairbox hidden">
        <input id="pin" inputmode="numeric" maxlength="6" autocomplete="one-time-code" placeholder="000000" />
        <button type="button" id="pair" class="ghost">Link</button>
      </div>
    </header>
    <p id="banner" class="note hidden"></p>
    <div id="thread" class="thread"></div>
    <footer>
      <div id="qbox" class="followq" hidden></div>
      <div id="drops" class="attachrow"></div>
      <textarea id="say" rows="2" placeholder="Ask about this folder"></textarea>
      <button type="button" id="attach" class="ghost">Attach</button>
      <button type="button" id="send">Send</button>
      <button type="button" id="stop" class="ghost" hidden>Stop</button>
      <input id="file" type="file" multiple accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.txt,.md,.csv,.json,.xlsx,.xls,.html,.heic,.mp4,.mov,.mp3,.m4a,.wav" />
    </footer>
  </div>
  <script>
    function pairFromHash(hash) {
      try {
        return String(new URLSearchParams(String(hash || '').replace(/^#/, '')).get('p') || '')
      } catch (e) {
        return ''
      }
    }
    function readStore(name) {
      try { return localStorage.getItem(name) || sessionStorage.getItem(name) || '' } catch (e) { return '' }
    }
    function writeStore(name, value) {
      try {
        localStorage.setItem(name, value)
        sessionStorage.setItem(name, value)
      } catch (e) {}
    }
    let token = readStore('brain-phone')
    let sealSecret = readStore('brain-phone-k')
    if (token && !sealSecret) {
      token = ''
      try {
        localStorage.removeItem('brain-phone')
        sessionStorage.removeItem('brain-phone')
      } catch (e) {}
    }
    const auth = { authorization: token ? ('Bearer ' + token) : '' }
    function b64(u8) {
      let s = ''
      const arr = u8 instanceof Uint8Array ? u8 : new Uint8Array(u8)
      for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i])
      return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
    }
    function unb64(s) {
      const pad = s.length % 4 === 2 ? '==' : s.length % 4 === 3 ? '=' : ''
      const bin = atob(String(s || '').replace(/-/g, '+').replace(/_/g, '/') + pad)
      const out = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
      return out
    }
    async function phoneKey() {
      const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sealSecret))
      return crypto.subtle.importKey('raw', buf, 'AES-GCM', false, ['encrypt', 'decrypt'])
    }
    async function seal(obj) {
      const iv = crypto.getRandomValues(new Uint8Array(12))
      const pt = new TextEncoder().encode(JSON.stringify(obj == null ? {} : obj))
      const key = await phoneKey()
      const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, key, pt))
      return {
        v: 1,
        iv: b64(iv),
        tag: b64(ct.slice(ct.length - 16)),
        data: b64(ct.slice(0, ct.length - 16))
      }
    }
    async function unseal(raw) {
      if (!raw || raw.v !== 1) throw new Error('bad')
      const iv = unb64(raw.iv)
      const data = unb64(raw.data)
      const tag = unb64(raw.tag)
      const ct = new Uint8Array(data.length + tag.length)
      ct.set(data, 0)
      ct.set(tag, data.length)
      const key = await phoneKey()
      const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv }, key, ct)
      return JSON.parse(new TextDecoder().decode(pt))
    }
    const app = document.getElementById('app')
    const thread = document.getElementById('thread')
    const tabsEl = document.getElementById('tabs')
    const kindEl = document.getElementById('kind')
    const pairbox = document.getElementById('pairbox')
    const pinEl = document.getElementById('pin')
    const pairBtn = document.getElementById('pair')
    const say = document.getElementById('say')
    const sendBtn = document.getElementById('send')
    const stopBtn = document.getElementById('stop')
    const attachBtn = document.getElementById('attach')
    const newBtn = document.getElementById('new')
    const closeBtn = document.getElementById('close')
    const fileEl = document.getElementById('file')
    const dropsEl = document.getElementById('drops')
    const qbox = document.getElementById('qbox')
    const banner = document.getElementById('banner')
    const title = document.getElementById('title')
    let active = ''
    let busyBy = {}
    let messages = {}
    let tabs = []
    let queueBy = {}
    let pending = null
    let eventsOn = false
    let openThink = {}
    let drops = []

    function pinChrome() {
      const vv = window.visualViewport
      const top = vv ? vv.offsetTop : 0
      const h = vv ? vv.height : window.innerHeight
      app.style.top = top + 'px'
      app.style.height = h + 'px'
    }
    pinChrome()
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', pinChrome)
      window.visualViewport.addEventListener('scroll', pinChrome)
    }

    function esc(s) {
      return String(s || '').replace(/[&<>"']/g, function (c) {
        return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
      })
    }
    function showBanner(text) {
      banner.textContent = text || ''
      banner.classList.toggle('hidden', !text)
    }
    function busy() {
      return Boolean(busyBy[active] || (pending && pending.tabId === active))
    }
    function msgs(id) {
      if (!messages[id]) messages[id] = []
      return messages[id]
    }
    function thinkLive(list, idx) {
      if (!busy()) return false
      for (let j = idx + 1; j < list.length; j++) {
        if (list[j].who === 'brain' && list[j].text) return false
        if (list[j].who === 'think' && list[j].text) return false
      }
      return true
    }
    function paintDrops() {
      dropsEl.innerHTML = drops.map(function (a, i) {
        return '<span class="chip">' + esc(a.name) + '<button type="button" class="linkish" data-drop="' + i + '">×</button></span>'
      }).join('')
    }
    function paintQueue() {
      const list = queueBy[active] || []
      qbox.hidden = list.length === 0
      qbox.innerHTML = list.length
        ? ('<p class="tiny">Queued. Runs after this turn.</p>' + list.map(function (q) {
            const extra = (q.names || []).length ? ' · ' + esc(q.names.join(', ')) : ''
            return '<div class="followq-row"><span>' + esc(q.text || 'Attachment') + extra + '</span>' +
              '<button type="button" class="linkish" data-qnow="' + esc(q.id) + '">Send now</button>' +
              '<button type="button" class="linkish" data-qedit="' + esc(q.id) + '">Edit</button>' +
              '<button type="button" class="linkish" data-qdrop="' + esc(q.id) + '">Delete</button></div>'
          }).join(''))
        : ''
    }
    function paint() {
      const list = msgs(active)
      const bits = []
      for (let i = 0; i < list.length; i++) {
        const m = list[i]
        if (m.who === 'think') {
          if (!m.html) continue
          const live = thinkLive(list, i)
          const key = active + '-t-' + i
          const open = openThink[key] === true || (openThink[key] !== false && live)
          bits.push(
            '<div class="bubble think"><button type="button" class="think-label" data-think="' + esc(key) + '">Thinking' +
              (open ? '' : ' · show') + '</button>' +
              (open ? '<div class="mdbody think-body">' + m.html + '</div>' : '') +
            '</div>'
          )
          continue
        }
        if (m.who === 'me') {
          bits.push('<div class="bubble me">' + esc(m.text) + '</div>')
          continue
        }
        if (m.who === 'sys') {
          bits.push('<div class="skin-tool"><span class="k">file</span><span class="p">' + esc(m.text) + '</span></div>')
          continue
        }
        bits.push('<div class="bubble md"><div class="mdbody">' + (m.html || esc(m.text)) + '</div></div>')
      }
      if (busy()) bits.push('<p class="pulse">Working</p>')
      thread.innerHTML = bits.join('')
      thread.scrollTop = thread.scrollHeight
      const tab = tabs.find(function (t) { return t.id === active })
      title.textContent = tab ? (tab.title || 'Chat') : 'This Mac'
      const queued = (queueBy[active] || []).length
      const hasText = Boolean(say.value.trim() || drops.length)
      sendBtn.textContent = busy() ? (hasText ? 'Queue' : queued ? 'Send now' : 'Queue') : 'Send'
      sendBtn.disabled = !token || !sealSecret || (!hasText && !(busy() && queued))
      stopBtn.hidden = !busy()
      stopBtn.disabled = !token || !sealSecret || !busy()
      closeBtn.disabled = !token || !sealSecret || !active
      newBtn.disabled = !token || !sealSecret
      kindEl.disabled = !token || !sealSecret
      say.placeholder = busy()
        ? (queued ? 'Enter queues. Empty Enter sends the next one.' : 'Working. Enter queues a follow-up.')
        : 'Ask about this folder'
      paintTabs()
      paintDrops()
      paintQueue()
    }
    function pinChatId(chatIds, current, macActive) {
      const ids = (chatIds || []).filter(Boolean)
      if (ids.indexOf(current) >= 0) return current
      if (ids.indexOf(macActive) >= 0) return macActive
      return ids[0] || ''
    }
    function pendingLanded(p, all) {
      if (!p) return true
      const list = all[p.tabId] || []
      let n = 0
      for (let i = 0; i < list.length; i++) {
        if (list[i].who === 'me' && list[i].text === p.text) n++
      }
      return n > p.meCount
    }
    function applyState(s) {
      tabs = (s.tabs || []).filter(function (t) { return t.type !== 'file' && t.type !== 'term' })
      const incoming = s.messages || {}
      Object.keys(incoming).forEach(function (id) {
        const have = messages[id] || []
        const next = incoming[id] || []
        messages[id] = next.length >= have.length ? next : have
      })
      active = pinChatId(tabs.map(function (t) { return t.id }), active, s.active || '')
      if (pending && pendingLanded(pending, messages)) pending = null
      busyBy = Object.assign({}, s.busy || {})
      if (pending) busyBy[pending.tabId] = true
      queueBy = s.queue || {}
      const cur = tabs.find(function (t) { return t.id === active })
      if (cur && cur.kind) kindEl.value = cur.kind === 'claude' || cur.kind === 'gpt' || cur.kind === 'cursor' ? cur.kind : 'grok'
      paint()
    }
    function tabName(t) {
      return t.title || (t.kind === 'claude' ? 'Claude' : t.kind === 'gpt' ? 'ChatGPT' : t.kind === 'cursor' ? 'Cursor' : 'Grok')
    }
    function paintTabs() {
      tabsEl.textContent = ''
      if (!tabs.length) {
        const empty = document.createElement('p')
        empty.className = 'tiny'
        empty.textContent = 'No chats yet. Tap New.'
        tabsEl.appendChild(empty)
        return
      }
      tabs.forEach(function (t) {
        const btn = document.createElement('button')
        btn.type = 'button'
        btn.className = 'tabchip' + (t.id === active ? ' on' : '')
        btn.setAttribute('data-tab', t.id)
        btn.setAttribute('role', 'option')
        btn.setAttribute('aria-selected', t.id === active ? 'true' : 'false')
        btn.textContent = tabName(t)
        tabsEl.appendChild(btn)
      })
    }
    function showPair(show) {
      pairbox.classList.toggle('hidden', !show)
    }
    function setCreds(nextToken, nextKey) {
      token = nextToken
      sealSecret = nextKey
      auth.authorization = token ? ('Bearer ' + token) : ''
      if (token && sealSecret) {
        writeStore('brain-phone', token)
        writeStore('brain-phone-k', sealSecret)
      }
    }
    async function pairWith(body) {
      const r = await fetch('/api/pair', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      })
      const open = await r.json().catch(function () { return {} })
      if (!r.ok || !open.ok || !open.token || !open.key) throw new Error(open.detail || 'Could not link this phone.')
      setCreds(open.token, open.key)
      try { history.replaceState({}, '', location.pathname) } catch (e) {}
    }
    async function pullState() {
      const r = await fetch('/api/state', { credentials: 'include', headers: auth })
      if (r.status === 401) {
        eventsOn = false
        showBanner('This phone is not linked. Scan the QR in Brain Settings, or type the 6-digit code.')
        showPair(true)
        return false
      }
      if (!r.ok) throw new Error('bad')
      applyState(await unseal(await r.json()))
      return true
    }
    function startPoll() {
      if (eventsOn || !token || !sealSecret) return
      eventsOn = true
      let misses = 0
      async function tick() {
        try {
          const ok = await pullState()
          if (ok === false) return
          misses = 0
          if (banner.textContent.indexOf('computer is off') >= 0) showBanner('')
        } catch (e) {
          misses += 1
          if (misses >= 3) showBanner('The computer is off or Brain.app is closed.')
        }
        if (!eventsOn) return
        const hot = Object.keys(busyBy).some(function (id) { return busyBy[id] })
        setTimeout(tick, hot ? 1200 : 4000)
      }
      void tick()
    }
    async function load() {
      const offer = pairFromHash(location.hash)
      if (offer) {
        try {
          await pairWith({ p: offer })
        } catch (e) {
          showBanner(String(e.message || e))
          showPair(true)
          return
        }
      }
      if (!token || !sealSecret) {
        showBanner('On the Mac: Settings → Phone. Scan the QR, or type the 6-digit code.')
        showPair(true)
        return
      }
      showPair(false)
      try {
        const ok = await pullState()
        if (!ok) return
        showBanner('')
        startPoll()
      } catch (e) {
        showBanner('The computer is off or Brain.app is closed.')
      }
    }
    async function postJson(path, body) {
      const r = await fetch(path, {
        method: 'POST',
        credentials: 'include',
        headers: Object.assign({ 'content-type': 'application/json' }, auth),
        body: JSON.stringify(await seal(body))
      })
      const data = await r.json().catch(function () { return {} })
      if (r.status === 401) throw new Error('This phone is not linked. Scan the QR in Brain Settings.')
      const open = data && data.v === 1 ? await unseal(data) : data
      if (!r.ok || open.ok === false) throw new Error(open.detail || 'Could not do that.')
      return open
    }
    async function send(queue) {
      let tabId = active
      if (!tabId) {
        try {
          const r = await postJson('/api/tab', { op: 'new', kind: kindEl.value || 'grok' })
          if (r.tabId) {
            tabId = r.tabId
            active = r.tabId
            await pullState()
            tabId = active || tabId
          }
        } catch (e) {
          showBanner(String(e.message || e))
          return
        }
      }
      const text = say.value.trim()
      const files = drops.slice()
      if ((!text && !files.length) || !tabId) {
        const q = (queueBy[tabId] || [])[0]
        if (q && !queue) {
          void postJson('/api/queue', { op: 'now', tabId: tabId, id: q.id }).then(function () { return pullState() }).catch(function (e) { showBanner(String(e.message || e)) })
        }
        return
      }
      if (!queue && busy()) queue = true
      let meCount = 0
      const shown = text + (files.length ? ((text ? '\\n' : '') + files.map(function (f) { return f.name }).join(', ')) : '')
      const have = messages[tabId] || []
      for (let i = 0; i < have.length; i++) {
        if (have[i].who === 'me' && have[i].text === shown) meCount++
      }
      if (!queue) {
        pending = { tabId: tabId, text: shown, meCount: meCount }
        busyBy[tabId] = true
      }
      say.value = ''
      drops = []
      showBanner('')
      paint()
      try {
        await postJson('/api/send', { text: text, tabId: tabId, files: files, queue: Boolean(queue) })
        showBanner('')
      } catch (e) {
        if (pending && pending.tabId === tabId && pending.text === shown) {
          say.value = text
          drops = files
          pending = null
        }
        showBanner(String(e.message || e))
        busyBy[tabId] = false
        paint()
      }
    }
    async function addFiles(list) {
      const skipped = []
      for (let i = 0; i < list.length; i++) {
        const f = list[i]
        if (f.size > 20 * 1024 * 1024) {
          skipped.push(f.name + ' is larger than 20 MB')
          continue
        }
        try {
          const bytes = b64(new Uint8Array(await f.arrayBuffer()))
          const body = await postJson('/api/attach', { name: f.name, mime: f.type || '', bytes: bytes })
          drops.push({ path: body.path, name: body.name || f.name, mime: body.mime || f.type || '' })
        } catch (e) {
          skipped.push(f.name + (e && e.message ? ' (' + e.message + ')' : ''))
        }
      }
      if (skipped.length) showBanner(skipped.join('. '))
      paint()
    }
    pairBtn.addEventListener('click', function () {
      const pin = String(pinEl.value || '').replace(/\D/g, '')
      if (pin.length !== 6) {
        showBanner('Type the 6-digit code from Settings on the Mac.')
        return
      }
      void pairWith({ pin: pin }).then(function () { return load() }).catch(function (e) {
        showBanner(String(e.message || e))
        showPair(true)
      })
    })
    pinEl.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault()
        pairBtn.click()
      }
    })
    tabsEl.addEventListener('click', function (e) {
      const btn = e.target.closest('[data-tab]')
      if (!btn) return
      active = btn.getAttribute('data-tab') || ''
      paint()
    })
    sendBtn.addEventListener('click', function () { void send(false) })
    stopBtn.addEventListener('click', function () {
      if (!active) return
      void postJson('/api/stop', { tabId: active }).then(function () {
        busyBy[active] = false
        pending = null
        paint()
      }).catch(function (e) { showBanner(String(e.message || e)) })
    })
    attachBtn.addEventListener('click', function () { fileEl.click() })
    fileEl.addEventListener('change', function () {
      const list = Array.from(fileEl.files || [])
      fileEl.value = ''
      if (list.length) void addFiles(list)
    })
    newBtn.addEventListener('click', function () {
      if (newBtn.disabled) return
      newBtn.disabled = true
      const kind = kindEl.value || 'grok'
      void postJson('/api/tab', { op: 'new', kind: kind }).then(function (r) {
        if (r.tabId) {
          active = r.tabId
          if (!tabs.some(function (t) { return t.id === r.tabId })) {
            tabs.push({ id: r.tabId, type: 'chat', title: tabName({ kind: kind }), kind: kind })
          }
          paint()
        }
        return pullState()
      }).then(function () { say.focus() }).catch(function (e) { showBanner(String(e.message || e)) }).finally(function () {
        newBtn.disabled = false
        paint()
      })
    })
    closeBtn.addEventListener('click', function () {
      if (!active) return
      if (!window.confirm('Close this chat?')) return
      void postJson('/api/tab', { op: 'close', tabId: active }).then(function () {
        active = ''
        return pullState()
      }).catch(function (e) { showBanner(String(e.message || e)) })
    })
    thread.addEventListener('click', function (e) {
      const btn = e.target.closest('[data-think]')
      if (!btn) return
      const key = btn.getAttribute('data-think')
      const openNow = Boolean(btn.parentNode && btn.parentNode.querySelector('.think-body'))
      openThink[key] = !openNow
      paint()
    })
    qbox.addEventListener('click', function (e) {
      const now = e.target.closest('[data-qnow]')
      const drop = e.target.closest('[data-qdrop]')
      const edit = e.target.closest('[data-qedit]')
      const id = (now || drop || edit) ? (now || drop || edit).getAttribute(now ? 'data-qnow' : drop ? 'data-qdrop' : 'data-qedit') : ''
      if (!id) return
      if (edit) {
        const item = (queueBy[active] || []).find(function (q) { return q.id === id })
        void postJson('/api/queue', { op: 'drop', tabId: active, id: id }).then(function () {
          if (item) say.value = item.text || ''
          if (item && item.files && item.files.length) drops = item.files.slice()
          return pullState()
        }).then(function () { paint() }).catch(function (e) { showBanner(String(e.message || e)) })
        return
      }
      void postJson('/api/queue', { op: now ? 'now' : 'drop', tabId: active, id: id }).then(function () {
        return pullState()
      }).catch(function (e) { showBanner(String(e.message || e)) })
    })
    dropsEl.addEventListener('click', function (e) {
      const btn = e.target.closest('[data-drop]')
      if (!btn) return
      drops.splice(Number(btn.getAttribute('data-drop')), 1)
      paint()
    })
    say.addEventListener('input', function () { paint() })
    say.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        void send(false)
      }
    })
    void load()
  </script>
</body>
</html>`
}
