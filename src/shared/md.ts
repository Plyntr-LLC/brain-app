export function stripAnsi(raw: string): string {
  return raw
    .replace(/\x1B\][^\x07]*\x07/g, '')
    .replace(/\x1B\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1B[PX^_].*?\x1B\\/g, '')
    .replace(/[\u2500-\u257F]/g, '')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
}

export function escapeHtml(s: string): string {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function inlineMd(t: string): string {
  t = t.replace(/`([^`]+)`/g, '<code>$1</code>')
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  t = t.replace(/__([^_]+)__/g, '<strong>$1</strong>')
  t = t.replace(/\*([^*\n]+)\*/g, '<em>$1</em>')
  t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label, href) => {
    if (!/^(https?:\/\/|\/|#|mailto:)/i.test(String(href))) return String(label)
    return `<a href="${href}">${label}</a>`
  })
  return t
}

function pipeRow(line: string): boolean {
  const t = line.trim()
  return t.startsWith('|') && t.split('|').length >= 3
}

function sepRow(line: string): boolean {
  const t = line.trim()
  return t.includes('---') && /^\|?[\s:|-]+\|?$/.test(t)
}

function cells(line: string): string[] {
  let t = line.trim()
  if (t.startsWith('|')) t = t.slice(1)
  if (t.endsWith('|')) t = t.slice(0, -1)
  return t.split('|').map((c) => c.trim())
}

function alignOf(sep: string): string {
  const left = sep.startsWith(':')
  const right = sep.endsWith(':')
  if (left && right) return 'center'
  if (right) return 'right'
  return 'left'
}

function tableHtml(lines: string[], start: number): { html: string; next: number } {
  const head = cells(lines[start]).map(inlineMd)
  const aligns = cells(lines[start + 1]).map(alignOf)
  let i = start + 2
  const rows: string[][] = []
  while (i < lines.length && pipeRow(lines[i]) && !sepRow(lines[i])) {
    rows.push(cells(lines[i]).map(inlineMd))
    i += 1
  }
  const th = head.map((c, n) => `<th style="text-align:${aligns[n] || 'left'}">${c}</th>`).join('')
  const body = rows
    .map((r) => {
      const td = head.map((_, n) => `<td style="text-align:${aligns[n] || 'left'}">${r[n] || ''}</td>`).join('')
      return `<tr>${td}</tr>`
    })
    .join('')
  return {
    html: `<div class="mdtable"><table><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table></div>`,
    next: i
  }
}

function proseToHtml(raw: string): string {
  const lines = escapeHtml(raw).replace(/\r\n/g, '\n').split('\n')
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) {
      i += 1
      continue
    }
    if (pipeRow(line) && i + 1 < lines.length && sepRow(lines[i + 1])) {
      const t = tableHtml(lines, i)
      out.push(t.html)
      i = t.next
      continue
    }
    if (/^### /.test(line)) {
      out.push(`<h3>${inlineMd(line.slice(4))}</h3>`)
      i += 1
      continue
    }
    if (/^## /.test(line)) {
      out.push(`<h2>${inlineMd(line.slice(3))}</h2>`)
      i += 1
      continue
    }
    if (/^# /.test(line)) {
      out.push(`<h1>${inlineMd(line.slice(2))}</h1>`)
      i += 1
      continue
    }
    if (/^[-*] /.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^[-*] /.test(lines[i])) {
        items.push(`<li>${inlineMd(lines[i].replace(/^[-*] /, ''))}</li>`)
        i += 1
      }
      out.push(`<ul>${items.join('')}</ul>`)
      continue
    }
    if (/^\d+\. /.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\d+\. /.test(lines[i])) {
        items.push(`<li>${inlineMd(lines[i].replace(/^\d+\. /, ''))}</li>`)
        i += 1
      }
      out.push(`<ol>${items.join('')}</ol>`)
      continue
    }
    const para: string[] = []
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^#{1,3} /.test(lines[i]) &&
      !/^[-*] /.test(lines[i]) &&
      !/^\d+\. /.test(lines[i]) &&
      !(pipeRow(lines[i]) && i + 1 < lines.length && sepRow(lines[i + 1]))
    ) {
      para.push(lines[i])
      i += 1
    }
    out.push(`<p>${inlineMd(para.join('\n')).replace(/\n/g, '<br>')}</p>`)
  }
  return out.join('\n')
}

export function mdToHtml(src: string): string {
  const chunks = String(src || '').split(/```/)
  const out: string[] = []
  for (let i = 0; i < chunks.length; i++) {
    if (i % 2 === 1) {
      const body = chunks[i].replace(/^[a-zA-Z0-9_-]*\n/, '')
      out.push(`<pre class="mdcode"><code>${escapeHtml(body)}</code></pre>`)
      continue
    }
    if (!chunks[i].trim()) continue
    out.push(proseToHtml(chunks[i]))
  }
  return out.join('\n')
}

export function tidy(text: string): string {
  return text.replace(/\.([A-Z][a-z])/g, '. $1').replace(/[ \t]+\n/g, '\n')
}

export function cleanThink(raw: string): string {
  let t = stripAnsi(raw)
  t = t.replace(/\{[^{}]{0,600}\}/g, ' ')
  t = t.replace(
    /\b(read_file|grep|list_dir|search_replace|glob_file_search|web_search|web_fetch|available_commands|auto-accept|Always allow|shift\+tab)\b/gi,
    ' '
  )
  t = t.replace(
    /(?:context|clients|personal|\.claude|\.agents|docs|plans|missions|todo)\/[A-Za-z0-9._/-]+\.[A-Za-z0-9]+/g,
    ' '
  )
  t = t.replace(/(?:CLAUDE|AGENTS)(?:\.local)?\.md/g, ' ')
  t = t.replace(/[ \t]+/g, ' ')
  t = t.replace(/\n{3,}/g, '\n\n')
  return tidy(t).trim()
}

export function phonePaintHtml(who: string, text: string): string {
  if (who === 'think') return mdToHtml(cleanThink(text))
  if (who === 'me' || who === 'sys') return escapeHtml(text)
  const raw = stripAnsi(text)
  const t = raw.trim()
  if (/^\{"(?:jsonrpc|method|id)"/.test(t) && t.length < 400 && !/\n/.test(t)) return ''
  if (t && !/\s/.test(t) && (/^(hook_|response_|turn_|agent_)/.test(t) || /_(started|completed|finished|cancelled)$/.test(t))) {
    return ''
  }
  return mdToHtml(raw)
}
