import { useCallback, useEffect, useRef, useState } from 'react'
import { Box, Static, Text, useInput, useStdout } from 'ink'
import TextInput from 'ink-text-input'
import type { TranscriptEntry, TuiHandlers } from './types.js'

export interface AppProps {
  /** Called once on mount to hand the live input/output handlers to `TuiIo`. */
  onReady(handlers: TuiHandlers): void
  /**
   * Called on Ctrl+C. `index.ts` decides what that means (cancel the running
   * task, or exit if nothing is running) — the component doesn't know about
   * `AbortController`s.
   */
  onInterrupt(): void
}

let nextEntryId = 0

/**
 * Only the end of a long reply is painted live. Ink repaints its dynamic area
 * by erasing it, and one taller than the terminal cannot be erased — it would
 * leave a smear of copies in the scrollback. The whole reply still lands in
 * the transcript once it is finished.
 */
function tail(text: string, rows: number): string {
  const lines = text.split('\n')
  return lines.length <= rows ? text : ['…', ...lines.slice(-(rows - 1))].join('\n')
}

/**
 * The whole TUI: a `<Static>` scrollback transcript (each entry is rendered
 * once and never re-painted, so normal terminal scrollback still works) plus
 * a fixed input line pinned below it. `<Static>` growing is what gives us
 * "scrollable transcript" for free from the terminal itself rather than
 * having to reimplement scrolling.
 */
export function App({ onReady, onInterrupt }: AppProps) {
  const [entries, setEntries] = useState<TranscriptEntry[]>([])
  const [status, setStatus] = useState<string | null>(null)
  const [live, setLive] = useState<string | null>(null)
  const { stdout } = useStdout()
  const [label, setLabel] = useState('> ')
  const [value, setValue] = useState('')
  const resolveInput = useRef<((value: string | null) => void) | null>(null)

  useEffect(() => {
    onReady({
      appendEntry(entry) {
        setEntries((prev) => [...prev, { ...entry, id: nextEntryId++ }])
      },
      setStatus(text) {
        setStatus(text)
      },
      setLive(text) {
        setLive(text)
      },
      requestInput(nextLabel) {
        setLabel(nextLabel)
        return new Promise((resolve) => {
          resolveInput.current = resolve
        })
      },
    })
    // `onReady` is a stable callback bound once by the caller before render;
    // this is intentionally mount-only and does not need to re-run.
  }, [])

  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      onInterrupt()
      return
    }
    if (key.ctrl && input === 'd' && value === '' && resolveInput.current) {
      const resolve = resolveInput.current
      resolveInput.current = null
      resolve(null)
    }
  })

  const handleSubmit = useCallback(
    (submitted: string) => {
      const resolve = resolveInput.current
      resolveInput.current = null
      setEntries((prev) => [...prev, { id: nextEntryId++, kind: 'input', text: `${label}${submitted}` }])
      setValue('')
      setLabel('> ')
      resolve?.(submitted)
    },
    [label],
  )

  return (
    <Box flexDirection="column">
      <Static items={entries}>
        {(entry) => (
          <Box key={entry.id}>
            <Text dimColor={entry.kind === 'input'} wrap="wrap">
              {entry.text}
            </Text>
          </Box>
        )}
      </Static>
      {live && (
        <Box marginTop={1}>
          {/* Room left for the status line and input box below it. */}
          <Text wrap="wrap">{tail(live, Math.max(3, (stdout.rows || 24) - 6))}</Text>
        </Box>
      )}
      {status && (
        <Box marginTop={1}>
          <Text color="yellow">{status}</Text>
        </Box>
      )}
      <Box marginTop={1}>
        <Text color="cyan">{label}</Text>
        <TextInput value={value} onChange={setValue} onSubmit={handleSubmit} />
      </Box>
    </Box>
  )
}
