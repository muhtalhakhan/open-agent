import { describe, expect, it } from 'vitest'
import { TuiIo } from './tui-io.js'
import type { TranscriptEntry, TuiHandlers } from './types.js'

function fakeHandlers(): TuiHandlers & {
  entries: Omit<TranscriptEntry, 'id'>[]
  statuses: (string | null)[]
  lives: (string | null)[]
} {
  const entries: Omit<TranscriptEntry, 'id'>[] = []
  const statuses: (string | null)[] = []
  const lives: (string | null)[] = []
  return {
    entries,
    statuses,
    lives,
    setLive(text) {
      lives.push(text)
    },
    appendEntry(entry) {
      entries.push(entry)
    },
    setStatus(text) {
      statuses.push(text)
    },
    requestInput() {
      return Promise.resolve('typed answer')
    },
  }
}

describe('TuiIo', () => {
  it('queues calls made before bind() and resolves them once the Ink root mounts', async () => {
    const io = new TuiIo()
    const promptPromise = io.prompt()
    const handlers = fakeHandlers()
    io.bind(handlers)

    expect(await promptPromise).toBe('typed answer')
  })

  it('end() answers the pending prompt, and every later one, with EOF', async () => {
    const io = new TuiIo()
    io.bind({ ...fakeHandlers(), requestInput: () => new Promise<string | null>(() => {}) })
    const pending = io.prompt()
    io.end()
    expect(await pending).toBeNull()
    expect(await io.prompt()).toBeNull()
  })

  it('write() appends a trimmed output entry and drops blank writes', () => {
    const io = new TuiIo()
    const handlers = fakeHandlers()
    io.bind(handlers)

    io.write('  hello there  \n\n')
    io.write('   \n')

    expect(handlers.entries).toEqual([{ kind: 'output', text: 'hello there' }])
  })

  it('setStatus() forwards straight through to the handlers', () => {
    const io = new TuiIo()
    const handlers = fakeHandlers()
    io.bind(handlers)

    io.setStatus('thinking…')
    io.setStatus(null)

    expect(handlers.statuses).toEqual(['thinking…', null])
  })

  it('ask() resolves to an empty string instead of null when the user hits Ctrl+D', async () => {
    const io = new TuiIo()
    io.bind({ ...fakeHandlers(), requestInput: () => Promise.resolve(null) })

    expect(await io.ask('Approve? [y/N] ')).toBe('')
  })

  describe('answerStream()', () => {
    it('repaints the reply live, then moves it into the transcript, formatted, when it ends', () => {
      const io = new TuiIo()
      const handlers = fakeHandlers()
      io.bind(handlers)
      const stream = io.answerStream((text) => text.toUpperCase())

      stream.onText({ type: 'delta', text: 'hel' })
      stream.onText({ type: 'delta', text: 'lo' })
      stream.onText({ type: 'end' })

      expect(handlers.lives).toEqual(['HEL', 'HELLO', null])
      expect(handlers.entries).toEqual([{ kind: 'output', text: 'HELLO' }])
      expect(stream.lastShown()).toBe(true)
    })

    it('wipes a reply that is reset, so only the attempt that finished reaches the transcript', () => {
      const io = new TuiIo()
      const handlers = fakeHandlers()
      io.bind(handlers)
      const stream = io.answerStream()

      stream.onText({ type: 'delta', text: 'half an ans' })
      stream.onText({ type: 'reset' })
      stream.onText({ type: 'delta', text: 'whole answer' })
      stream.onText({ type: 'end' })

      expect(handlers.entries).toEqual([{ kind: 'output', text: 'whole answer' }])
    })

    it('reports a reply that never streamed as not shown, so the REPL still prints it', () => {
      const io = new TuiIo()
      const handlers = fakeHandlers()
      io.bind(handlers)
      const stream = io.answerStream()

      stream.onText({ type: 'end' })

      expect(handlers.entries).toEqual([])
      expect(stream.lastShown()).toBe(false)
    })

    it('close() keeps a reply that was cut short in the transcript', () => {
      const io = new TuiIo()
      const handlers = fakeHandlers()
      io.bind(handlers)
      const stream = io.answerStream()

      stream.onText({ type: 'delta', text: 'interrupted mid' })
      stream.close()

      expect(handlers.entries).toEqual([{ kind: 'output', text: 'interrupted mid' }])
      expect(handlers.lives.at(-1)).toBeNull()
    })
  })
})
