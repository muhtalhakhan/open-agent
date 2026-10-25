const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  copy: '©',
  reg: '®',
  trade: '™',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  bull: '•',
  middot: '·',
  laquo: '«',
  raquo: '»',
}

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, entity: string) => {
    if (entity[0] === '#') {
      const code =
        entity[1] === 'x' || entity[1] === 'X' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? whole
  })
}

/** Elements whose content is never prose: dropped whole, content and all. */
const DROPPED = ['script', 'style', 'noscript', 'svg', 'template', 'iframe', 'object', 'canvas', 'head', 'title']
// No `li`: each opening tag has already started its line, so a closing one adds nothing.
const BLOCKS =
  /^(p|div|section|article|main|header|footer|aside|nav|br|hr|tr|table|ul|ol|dl|dd|dt|blockquote|pre|figure|figcaption|form|h[1-6])$/i

/**
 * A page's readable text: what a person would read, with headings, list
 * items and links kept recognisable, and the markup, scripts and styles gone.
 * Deliberately small rather than a full HTML parser — it only has to give a
 * model the gist of a page, and an odd page degrading to slightly worse
 * spacing costs nothing.
 */
export function htmlToText(html: string): { title?: string; text: string } {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]
  // Comments, then declarations like <!doctype> and processing instructions.
  let body = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<[!?][^>]*>/g, '')
  for (const tag of DROPPED) body = body.replace(new RegExp(`<${tag}\\b[\\s\\S]*?</${tag}\\s*>`, 'gi'), ' ')

  body = body
    // A link keeps where it goes, so the model can follow it.
    .replace(/<a\b[^>]*?href\s*=\s*["']([^"']*)["'][^>]*>([\s\S]*?)<\/a\s*>/gi, (_, href: string, inner: string) => {
      const label = inner.replace(/<[^>]+>/g, '').trim()
      return label && href && !href.startsWith('#') && !href.startsWith('javascript:') ? `${label} (${href})` : label
    })
    .replace(/<h([1-6])\b[^>]*>/gi, (_, level: string) => `\n\n${'#'.repeat(Number(level))} `)
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/?([a-z][a-z0-9]*)\b[^>]*>/gi, (_, tag: string) =>
      BLOCKS.test(tag) ? '\n' : tag.toLowerCase() === 'td' || tag.toLowerCase() === 'th' ? ' | ' : '',
    )

  const text = decodeEntities(body)
    .split('\n')
    .map((line) => line.replace(/[ \t\f\v\u00a0]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  const cleanTitle = title ? decodeEntities(title).replace(/\s+/g, ' ').trim() : undefined
  return { ...(cleanTitle ? { title: cleanTitle } : {}), text }
}
