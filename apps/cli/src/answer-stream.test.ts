import { describe, expect, it } from 'vitest'
import type { RunTextEvent } from '@open-agent/agent'
import { RESTART_NOTICE, createTerminalAnswerStream } from './answer-stream.js'
import { renderMarkdown } from './markdown.js'

function terminal(markdown = false) {
  const writes: string[] = []
  const stream = createTerminalAnswerStream((text) => writes.push(text), { markdown })
  const send = (...events: RunTextEvent[]) => events.forEach((event) => stream.onText(event))
  return { stream, writes, send, output: () => writes.join('') }
}

const delta = (text: string): RunTextEvent => ({ type: 'delta', text })

describe('createTerminalAnswerStream', () => {
  it('writes plain text the moment it arrives, framed the way a whole answer is', () => {
    const { send, writes, output, stream } = terminal()

    send(delta('Hel'))
    expect(output()).toBe('\nHel')
    send(delta('lo'), { type: 'end' })

    expect(writes).toEqual(['\n', 'Hel', 'lo', '\n', '\n'])
    expect(output()).toBe('\nHello\n\n')
    expect(stream.lastShown()).toBe(true)
  })

  it('renders Markdown a line at a time, holding a line back until it is complete', () => {
    const { send, output } = terminal(true)

    send(delta('# Ti'))
    expect(output()).toBe('\n')
    send(delta('tle\n- one'))
    expect(output()).toBe(`\n${renderMarkdown('# Title')}\n`)
    send({ type: 'end' })
    expect(output()).toBe(`\n${renderMarkdown('# Title\n- one')}\n\n`)
  })

  it('renders a streamed answer exactly as the whole answer would be rendered', () => {
    const answer = [
      '## Result',
      '',
      'Some **bold** and `code`.',
      '| a | b |',
      '| --- | --- |',
      '| 1 | 22 |',
      'after the table',
      '```ts',
      'const x = 1',
      '```',
      '| not a table |',
      '> quoted',
    ].join('\n')
    const { send, output } = terminal(true)

    for (let i = 0; i < answer.length; i += 3) send(delta(answer.slice(i, i + 3)))
    send({ type: 'end' })

    expect(output()).toBe(`\n${renderMarkdown(answer)}\n\n`)
  })

  it('announces a reset instead of pretending the printed text is gone, then starts the reply over', () => {
    const { send, output } = terminal()

    send(delta('half an ans'), { type: 'reset' }, delta('whole answer'), { type: 'end' })

    expect(output()).toBe(`\nhalf an ans\n${RESTART_NOTICE}\n\nwhole answer\n\n`)
  })

  it('says nothing about a reset when nothing had been shown', () => {
    const { send, output } = terminal()
    send({ type: 'reset' }, delta('answer'), { type: 'end' })
    expect(output()).toBe('\nanswer\n\n')
  })

  it('reports a reply that never streamed as not shown, so the REPL still prints it', () => {
    const { send, stream, output } = terminal()

    send(delta('Let me look that up.'), { type: 'end' }, { type: 'end' })

    expect(output()).toBe('\nLet me look that up.\n\n')
    expect(stream.lastShown()).toBe(false)
  })

  it('close() finishes a reply that was cut short', () => {
    const { send, stream, output } = terminal(true)
    send(delta('interrupted mid'))
    stream.close()
    expect(output()).toBe('\ninterrupted mid\n\n')
  })
})
