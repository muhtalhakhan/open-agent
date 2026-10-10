/** @jsxRuntime automatic */
/** @jsxImportSource react */
// Also set in tsconfig.json, but that isn't enough: the `open-agent` bin runs
// through tsx, which reads the tsconfig of the directory it is launched from.
// Started anywhere but apps/cli, it compiled JSX to `React.createElement`
// with no `React` in scope, and the TUI crashed on its first render. esbuild
// only honours a pragma that opens its own comment, hence two of them.
import { useCallback, useEffect, useRef, useState } from 'react'
import { Box, Static, Text, useInput } from 'ink'
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
 * The whole TUI: a `<Static>` scrollback transcript (each entry is rendered
 * once and never re-painted, so normal terminal scrollback still works) plus
 * a fixed input line pinned below it. `<Static>` growing is what gives us
 * "scrollable transcript" for free from the terminal itself rather than
 * having to reimplement scrolling.
 */
export function App({ onReady, onInterrupt }: AppProps) {
  const [entries, setEntries] = useState<TranscriptEntry[]>([])
  const [status, setStatus] = useState<string | null>(null)
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
