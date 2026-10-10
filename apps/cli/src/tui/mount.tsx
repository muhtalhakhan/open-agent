/** @jsxRuntime automatic */
/** @jsxImportSource react */
// Also set in tsconfig.json, but that isn't enough: the `open-agent` bin runs
// through tsx, which reads the tsconfig of the directory it is launched from.
// Started anywhere but apps/cli, it compiled JSX to `React.createElement`
// with no `React` in scope, and the TUI crashed on its first render. esbuild
// only honours a pragma that opens its own comment, hence two of them.
import { render } from 'ink'
import { App } from './App.js'
import { TuiIo } from './tui-io.js'

export interface MountTuiOptions {
  /** Forwarded from Ink's Ctrl+C handling — see `App`'s `onInterrupt` prop. */
  onInterrupt(): void
}

export interface MountedTui {
  io: TuiIo
  unmount(): void
}

/** Renders the Ink app and returns a `TuiIo` wired up to it, ready to hand to `runRepl`. */
export function mountTui(options: MountTuiOptions): MountedTui {
  const io = new TuiIo()
  const instance = render(<App onReady={(handlers) => io.bind(handlers)} onInterrupt={options.onInterrupt} />)
  return {
    io,
    unmount: () => instance.unmount(),
  }
}
