import { createInterface } from 'node:readline'
import { Writable } from 'node:stream'
import { createLineReader } from './line-reader.js'
import type { InitIO } from './init.js'

/**
 * The wizard's terminal: one readline, one line queue (see line-reader.ts),
 * and echo that can be switched off while a key is typed.
 *
 * readline echoes what is typed by writing it to its output, so the output it
 * is given is a gate in front of the real one: closed, the keystrokes go
 * nowhere, while the question itself is written past the gate. Taking the
 * streams as arguments rather than reaching for `process` keeps index.ts the
 * only file that touches the real ones.
 */
export function createTerminalInitIO(
  input: NodeJS.ReadableStream & { isTTY?: boolean },
  output: NodeJS.WritableStream & { isTTY?: boolean },
): InitIO & { close(): void } {
  let muted = false
  const gate = new Writable({
    write(chunk, _encoding, callback) {
      if (!muted) output.write(chunk)
      callback()
    },
  })
  const rl = createInterface({ input, output: gate, terminal: Boolean(input.isTTY && output.isTTY) })
  const reader = createLineReader(rl)
  // Without a listener, readline answers Ctrl+C by pausing input, and the
  // wizard would wait forever on a question nobody can answer. Closing ends
  // input, which the wizard treats as "stop, write nothing".
  rl.on('SIGINT', () => rl.close())

  return {
    ask: (question) => reader.next(question),
    async askSecret(question) {
      output.write(question)
      muted = true
      try {
        return await reader.next('')
      } finally {
        muted = false
        // The Enter that ended the key was swallowed with the rest.
        output.write('\n')
      }
    },
    write: (text) => void output.write(text),
    close: () => rl.close(),
  }
}
