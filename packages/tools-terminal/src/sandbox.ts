import { spawn } from 'node:child_process'
import os from 'node:os'

/**
 * Isolation for the shell tools.
 *
 * Everything else the terminal package does is advisory: the workspace root
 * bounds where a command *starts*, the destructive-command rules catch a
 * handful of spellings, and credential filtering cleans the environment. A
 * command that wants to read `~/.ssh/id_rsa` and POST it somewhere defeats all
 * three, because a shell command is opaque to any check made on its text.
 *
 * A sandbox is the part that is not advisory. It is enforced by the kernel or
 * a container runtime rather than by a regex, so it holds whatever the command
 * turns out to be.
 *
 * The seam here is deliberately small — turn a command into the argv that runs
 * it under this backend, and say whether the backend works. The full
 * provider-neutral surface (lifecycle, file transfer, capability negotiation,
 * a desktop) is #136, and building it here would be inventing an interface for
 * one caller.
 */

export interface SandboxSpec {
  /** The shell command, exactly as the model wrote it. */
  command: string
  /** Absolute working directory. Inside `workspaceRoot`. */
  cwd: string
  /** Absolute path the command may write to. Everything else is read-only or absent. */
  workspaceRoot: string
  /** Whether the command may reach the network. */
  network: boolean
}

export interface Sandbox {
  /** Short name, as it appears in config and in the startup line. */
  name: string
  /**
   * Whether this backend actually works here — probed by running something,
   * not by looking for the binary. `bwrap` is installed on plenty of machines
   * that deny it the user namespace it needs, and finding that out at the
   * first real command means finding it out too late.
   */
  available(): Promise<boolean>
  /** The argv that runs `spec.command` under this backend. */
  wrap(spec: SandboxSpec): { file: string; args: string[] }
  /** One line on what this does and does not contain. Shown at startup. */
  describe(): string
}

/** The shell a command ultimately runs in, inside whatever wrapping is applied. */
function innerShell(command: string): { file: string; args: string[] } {
  if (process.platform === 'win32') {
    return { file: process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', command] }
  }
  return { file: '/bin/sh', args: ['-c', command] }
}

/**
 * No isolation at all: the command runs with the privileges of whoever
 * started the agent.
 *
 * Kept as a named backend rather than a fallback, so that running without a
 * sandbox is something an operator chose and can be seen to have chosen,
 * instead of what silently happens when nothing else is installed.
 */
export function noneSandbox(): Sandbox {
  return {
    name: 'none',
    async available() {
      return true
    },
    wrap(spec) {
      return innerShell(spec.command)
    },
    describe() {
      return 'no isolation — commands run with your full privileges and can read anything you can'
    },
  }
}

export interface BubblewrapOptions {
  /** Path to the binary (default `bwrap`). */
  binary?: string
}

/**
 * Linux user namespaces via bubblewrap.
 *
 * The whole filesystem is bound read-only and the workspace is then bound over
 * it read-write, so a command sees a normal system it cannot modify, with one
 * writable directory. `/tmp` is a fresh tmpfs — bound *before* the workspace,
 * because bwrap applies operations in order and a workspace under `/tmp`
 * would otherwise be buried by the tmpfs that came after it.
 *
 * No daemon, no image, no root: the cheap option where it works.
 */
export function bubblewrapSandbox(options: BubblewrapOptions = {}): Sandbox {
  const binary = options.binary ?? 'bwrap'

  const build = (spec: SandboxSpec): string[] => {
    const args = [
      '--ro-bind',
      '/',
      '/',
      '--dev',
      '/dev',
      '--proc',
      '/proc',
      '--tmpfs',
      '/tmp',
      // After the tmpfs, so a workspace under /tmp survives it.
      '--bind',
      spec.workspaceRoot,
      spec.workspaceRoot,
      '--chdir',
      spec.cwd,
      '--unshare-pid',
      // Without this, a command that outlives the agent keeps running with no
      // one holding its leash.
      '--die-with-parent',
      '--new-session',
    ]
    if (!spec.network) args.push('--unshare-net')
    return args
  }

  return {
    name: 'bubblewrap',
    async available() {
      // Probed with the real flags, network unsharing included: bwrap can be
      // installed, and can even start, while still being denied the namespaces
      // that make it a sandbox.
      const workspace = os.tmpdir()
      const { file, args } = this.wrap({ command: 'exit 0', cwd: workspace, workspaceRoot: workspace, network: false })
      return probe(file, args)
    },
    wrap(spec) {
      const inner = innerShell(spec.command)
      return { file: binary, args: [...build(spec), '--', inner.file, ...inner.args] }
    },
    describe() {
      return 'bubblewrap — read-only filesystem, the workspace writable, no network unless allowed'
    },
  }
}

export interface DockerOptions {
  /**
   * Image the command runs in. The default has a shell and little else: a
   * command needing node, python or a compiler needs an image that has them,
   * which is the operator's decision rather than a default anyone can guess.
   */
  image?: string
  /** Path to the binary (default `docker`). */
  binary?: string
  /** Memory ceiling passed to the runtime (default 2g). */
  memory?: string
  /** Process ceiling, against fork bombs (default 512). */
  pidsLimit?: number
  /**
   * `uid:gid` the command runs as. Defaults to the agent's own on POSIX.
   * Overridable because an image whose toolchain expects root will fail
   * without it — at the cost of the two problems the default solves.
   */
  user?: string
}

export const DEFAULT_DOCKER_IMAGE = 'alpine:3.20'

/** The agent's own uid:gid, where the platform has them. */
function defaultUser(): string | undefined {
  if (process.platform === 'win32') return undefined
  const uid = process.getuid?.()
  const gid = process.getgid?.()
  return uid === undefined || gid === undefined ? undefined : `${uid}:${gid}`
}

/**
 * A container per command.
 *
 * Only the workspace is mounted, and at the same absolute path it has on the
 * host — so a path the model got from `read_file` still resolves when it hands
 * that path to `run_command`. Mounting it somewhere tidier like `/workspace`
 * would silently break every path the rest of the toolset produced.
 *
 * Slower to start than bubblewrap and needs a daemon, but it works on macOS
 * and gives a command a filesystem that is not the host's at all.
 */
export function dockerSandbox(options: DockerOptions = {}): Sandbox {
  const binary = options.binary ?? 'docker'
  const image = options.image ?? DEFAULT_DOCKER_IMAGE

  const build = (spec: SandboxSpec): string[] => {
    const args = [
      'run',
      '--rm',
      '--volume',
      `${spec.workspaceRoot}:${spec.workspaceRoot}`,
      '--workdir',
      spec.cwd,
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--pids-limit',
      String(options.pidsLimit ?? 512),
      '--memory',
      options.memory ?? '2g',
    ]

    // Two things at once. Files the command creates in the workspace end up
    // owned by the user rather than by root, which is the difference between
    // a workspace you can still edit afterwards and one you have to chown
    // your way out of. And `--cap-drop ALL` takes CAP_DAC_OVERRIDE with it,
    // so a root process could not write to the user's directory anyway.
    const user = options.user ?? defaultUser()
    if (user) args.push('--user', user)
    args.push('--network', spec.network ? 'bridge' : 'none')
    args.push(image)
    return args
  }

  return {
    name: 'docker',
    async available() {
      // `docker info` rather than a container run: it fails fast when the
      // daemon is down, and does not pull an image on a machine that may not
      // want one pulled.
      return probe(binary, ['info'])
    },
    wrap(spec) {
      const inner = innerShell(spec.command)
      return { file: binary, args: [...build(spec), inner.file, ...inner.args] }
    },
    describe() {
      return `docker (${image}) — only the workspace is mounted, no capabilities, no network unless allowed`
    },
  }
}

/** Runs a command with a short deadline purely to see whether it works at all. */
function probe(file: string, args: string[], timeoutMs = 10_000): Promise<boolean> {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(file, args, { stdio: 'ignore' })
    } catch {
      resolve(false)
      return
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve(false)
    }, timeoutMs)
    timer.unref()
    child.on('error', () => {
      clearTimeout(timer)
      resolve(false)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve(code === 0)
    })
  })
}

export type SandboxName = 'auto' | 'none' | 'bubblewrap' | 'docker'

export interface SelectSandboxOptions {
  docker?: DockerOptions
  bubblewrap?: BubblewrapOptions
}

/**
 * Picks a backend, probing it before handing it back.
 *
 * `auto` prefers bubblewrap — no daemon, no image, and it starts in
 * milliseconds — and falls back to docker. It never falls back to `none`:
 * silently dropping isolation because a binary was missing is precisely the
 * failure this issue exists to prevent, so `auto` returning `undefined` is the
 * caller's cue to say so out loud rather than carry on unsandboxed.
 */
export async function selectSandbox(
  name: SandboxName,
  options: SelectSandboxOptions = {},
): Promise<Sandbox | undefined> {
  if (name === 'none') return noneSandbox()

  const candidates: Sandbox[] =
    name === 'auto'
      ? [bubblewrapSandbox(options.bubblewrap), dockerSandbox(options.docker)]
      : name === 'bubblewrap'
        ? [bubblewrapSandbox(options.bubblewrap)]
        : [dockerSandbox(options.docker)]

  for (const candidate of candidates) {
    if (await candidate.available()) return candidate
  }
  return undefined
}
