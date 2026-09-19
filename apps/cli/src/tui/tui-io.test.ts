import { describe, expect, it } from 'vitest'
import { TuiIo } from './tui-io.js'
import type { TranscriptEntry, TuiHandlers } from './types.js'

function fakeHandlers(): TuiHandlers & { entries: Omit<TranscriptEntry, 'id'>[]; statuses: (string | null)[] } {
  const entries: Omit<TranscriptEntry, 'id'>[] = []
  const statuses: (string | null)[] = []
  return {
    entries,
    statuses,
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
})
