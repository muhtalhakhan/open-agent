import { describe, expect, it } from 'vitest'
import { renderInline, renderMarkdown, shouldRenderMarkdown } from './markdown.js'

// eslint-disable-next-line no-control-regex
const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, '')
const B = (t: string) => `\x1b[1m${t}\x1b[22m`
const I = (t: string) => `\x1b[3m${t}\x1b[23m`
const CODE = (t: string) => `\x1b[36m${t}\x1b[39m`

describe('renderInline', () => {
  it('styles bold, italic, code and strikethrough, dropping the markers', () => {
    expect(renderInline('**bold** and *italic* and `code` and ~~gone~~')).toBe(
      `${B('bold')} and ${I('italic')} and ${CODE('code')} and \x1b[9mgone\x1b[29m`,
    )
    expect(renderInline('__bold__ and _italic_')).toBe(`${B('bold')} and ${I('italic')}`)
  })

  it('leaves snake_case, arithmetic and lone markers alone', () => {
    expect(renderInline('call load_config_from_env now')).toBe('call load_config_from_env now')
    expect(renderInline('2 * 3 * 4 = 24')).toBe('2 * 3 * 4 = 24')
    expect(renderInline('a lone * star')).toBe('a lone * star')
  })

  it('does not read emphasis inside code spans or URLs', () => {
    expect(renderInline('`a*b*c` and `__init__`')).toBe(`${CODE('a*b*c')} and ${CODE('__init__')}`)
    expect(plain(renderInline('[docs](https://x.dev/_private_/a*b*)'))).toBe('docs (https://x.dev/_private_/a*b*)')
  })

  it('shows a link as its label and URL, or just the URL when they match', () => {
    expect(plain(renderInline('see [the guide](https://example.com/guide)'))).toBe(
      'see the guide (https://example.com/guide)',
    )
    expect(plain(renderInline('[https://a.b](https://a.b)'))).toBe('https://a.b')
  })

  it('keeps code and escapes that sit inside a link label', () => {
    expect(plain(renderInline('see [`README.md`](README.md)'))).toBe('see README.md (README.md)')
    expect(plain(renderInline('[foo\\_bar](https://x.dev)'))).toBe('foo_bar (https://x.dev)')
  })

  it('honours backslash escapes', () => {
    expect(renderInline('\\*not italic\\*')).toBe('*not italic*')
  })
})

describe('renderMarkdown', () => {
  it('drops heading markers and styles the text', () => {
    const out = renderMarkdown('# Title\n## Section ##\n###### Small')
    expect(plain(out)).toBe('Title\nSection\nSmall')
    // A trailing # is only a closing marker after a space.
    expect(plain(renderMarkdown('## Using C#\n# F#\n## Closed ##'))).toBe('Using C#\nF#\nClosed')
    expect(out.split('\n')[0]).toContain('\x1b[4m') // the top heading is underlined
  })

  it('draws bullets, keeps numbering and nesting, and shows task boxes', () => {
    expect(
      plain(renderMarkdown('- one\n  * nested **bold**\n+ three\n1. first\n2) second\n- [x] done\n- [ ] todo')),
    ).toBe('• one\n  • nested bold\n• three\n1. first\n2. second\n☑ done\n☐ todo')
  })

  it('prints fenced code verbatim and indented, with its language', () => {
    const out = renderMarkdown('before\n```ts\nconst x = **not bold**\n# not a heading\n```\nafter')
    expect(plain(out)).toBe('before\n  ts\n  const x = **not bold**\n  # not a heading\nafter')
  })

  it('recognises a fence with more after the language, and closes it', () => {
    const out = renderMarkdown('```ts title="a.ts"\nconst a = 1\n```\n**after**\n```js {1,3}\nx\n```\ndone')
    expect(plain(out)).toBe('  ts\n  const a = 1\nafter\n  js\n  x\ndone')
    expect(out).toContain('\x1b[1mafter\x1b[22m')
  })

  it('treats an unclosed fence as code to the end', () => {
    expect(plain(renderMarkdown('```\nline one\n- still code'))).toBe('  line one\n  - still code')
  })

  it('renders quotes and horizontal rules', () => {
    expect(plain(renderMarkdown('> quoted *text*\n\n---\n***'))).toBe(
      `│ quoted text\n\n${'─'.repeat(40)}\n${'─'.repeat(40)}`,
    )
  })

  it('aligns table columns by what is visible, not by the markup', () => {
    const out = renderMarkdown('| Name | Notes |\n|------|:-----:|\n| **a** | `x` |\n| longer name | y |')
    expect(plain(out).split('\n')).toEqual([
      'Name         Notes',
      '───────────  ─────',
      'a            x',
      'longer name  y',
    ])
  })

  it('leaves a pipe line without a divider as ordinary text', () => {
    expect(plain(renderMarkdown('| not | a table |'))).toBe('| not | a table |')
  })

  it('keeps plain prose and blank lines exactly, CRLF included', () => {
    expect(renderMarkdown('Just text.\r\n\r\nMore text.')).toBe('Just text.\n\nMore text.')
  })
})

describe('shouldRenderMarkdown', () => {
  it('renders only for a terminal that has not asked for plain output', () => {
    expect(shouldRenderMarkdown(true, {})).toBe(true)
    expect(shouldRenderMarkdown(false, {})).toBe(false)
    expect(shouldRenderMarkdown(undefined, {})).toBe(false)
    expect(shouldRenderMarkdown(true, { NO_COLOR: '1' })).toBe(false)
    expect(shouldRenderMarkdown(true, { TERM: 'dumb' })).toBe(false)
  })
})
