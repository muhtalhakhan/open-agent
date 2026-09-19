import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { createApprovalAsk, createLineReader, type LineSource } from './line-reader.js'

/**
 * A stand-in for readline: an emitter that records the prompts it was asked to
 * show. Real stdin is not needed to reproduce the bug — emitting several
 * `line` events in a row is exactly what readline does with one chunk.
 */
class FakeReadline extends EventEmitter implements LineSource {
  readonly prompts: string[] = []
  private pending = ''

  setPrompt(prompt: string): void {
    this.pending = prompt
  }

  prompt(): void {
    this.prompts.push(this.pending)
  }

  /** One chunk of piped input: every line emitted before anything can await. */
  chunk(...lines: string[]): void {
    for (const line of lines) this.emit('line', line)
  }
}

describe('createLineReader', () => {
  it('keeps every line of a chunk that arrives at once', async () => {
    const rl = new FakeReadline()
    const reader = createLineReader(rl)

    rl.chunk('first', 'second', ':exit')

    expect(await reader.next('> ')).toBe('first')
    expect(await reader.next('> ')).toBe('second')
    expect(await reader.next('> ')).toBe(':exit')
  })

  it('keeps lines that arrive before anyone reads, however slow startup was', async () => {
    const rl = new FakeReadline()
    const reader = createLineReader(rl)

    rl.chunk('a task typed before the first prompt')
    await new Promise((resolve) => setTimeout(resolve, 5))

    expect(await reader.next('> ')).toBe('a task typed before the first prompt')
  })

  it('hands a waiting reader the next line as it arrives', async () => {
    const rl = new FakeReadline()
    const reader = createLineReader(rl)

    const pending = reader.next('> ')
    expect(rl.prompts).toEqual(['> '])
    rl.chunk('typed later')

    expect(await pending).toBe('typed later')
  })

  it('reports EOF once closed with nothing queued', async () => {
    const rl = new FakeReadline()
    const reader = createLineReader(rl)

    rl.emit('close')

    expect(await reader.next('> ')).toBeNull()
  })

  it('drains what is queued before reporting EOF', async () => {
    const rl = new FakeReadline()
    const reader = createLineReader(rl)

    // A final chunk and the EOF that followed it in the same breath.
    rl.chunk('still to run')
    rl.emit('close')

    expect(await reader.next('> ')).toBe('still to run')
    expect(await reader.next('> ')).toBeNull()
  })

  it('settles a question that was pending when input ended', async () => {
    const rl = new FakeReadline()
    const reader = createLineReader(rl)

    const pending = reader.next('> ')
    rl.emit('close')

    // Left unsettled, the session would drain away unsaved.
    expect(await pending).toBeNull()
  })

  it('shows the prompt it was given, and only when it has to wait', async () => {
    const rl = new FakeReadline()
    const reader = createLineReader(rl)

    rl.chunk('queued')
    await reader.next('> ')
    expect(rl.prompts).toEqual([])

    void reader.next('approve? ')
    expect(rl.prompts).toEqual(['approve? '])
  })

  it('discards only the lines that arrived before it was called', async () => {
    const rl = new FakeReadline()
    const reader = createLineReader(rl)

    rl.chunk('typed ahead as the next task')
    reader.discardQueued()
    rl.chunk('the real answer')

    expect(await reader.next('approve? ')).toBe('the real answer')
  })

  it('serves readers in order when several are waiting', async () => {
    const rl = new FakeReadline()
    const reader = createLineReader(rl)

    const first = reader.next('> ')
    rl.chunk('one')
    const second = reader.next('> ')
    rl.chunk('two')

    expect(await first).toBe('one')
    expect(await second).toBe('two')
  })

  it('survives a reader that asks again synchronously as it is resolved', async () => {
    const rl = new FakeReadline()
    const reader = createLineReader(rl)
    const seen: (string | null)[] = []

    void reader.next('> ').then((line) => {
      seen.push(line)
      return reader.next('> ').then((next) => void seen.push(next))
    })
    rl.chunk('one')
    await new Promise((resolve) => setTimeout(resolve, 0))
    rl.chunk('two')
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(seen).toEqual(['one', 'two'])
  })
})

describe('createApprovalAsk', () => {
  it('will not let a line typed ahead answer a question it never saw', async () => {
    const rl = new FakeReadline()
    const reader = createLineReader(rl)
    const ask = createApprovalAsk(reader, true)

    // The user was typing their next task, not approving anything.
    rl.chunk('yes, refactor the parser next')
    const pending = ask('Approve "run_command"? [y/N] ')
    rl.chunk('n')

    expect(await pending).toBe('n')
  })

  it('takes the next scripted line when input is piped', async () => {
    const rl = new FakeReadline()
    const reader = createLineReader(rl)
    const ask = createApprovalAsk(reader, false)

    // A script writes its answers in order, knowing which prompts will come.
    rl.chunk('y')

    expect(await ask('Approve "run_command"? [y/N] ')).toBe('y')
  })

  it('answers nothing at EOF rather than hanging', async () => {
    const rl = new FakeReadline()
    const reader = createLineReader(rl)
    const ask = createApprovalAsk(reader, false)

    rl.emit('close')

    expect(await ask('Approve? ')).toBe('')
  })
})
