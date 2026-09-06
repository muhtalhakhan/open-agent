import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { bubblewrapSandbox, dockerSandbox, noneSandbox, selectSandbox } from './sandbox.js'
import { execute } from './execute.js'

const spec = { command: 'echo hi', cwd: '/work/sub', workspaceRoot: '/work', network: false }

describe('noneSandbox', () => {
  it('runs the command through a bare shell', () => {
    expect(noneSandbox().wrap(spec)).toEqual({ file: '/bin/sh', args: ['-c', 'echo hi'] })
  })

  it('is always available, being nothing at all', async () => {
    await expect(noneSandbox().available()).resolves.toBe(true)
  })

  it('says plainly that it is not isolation', () => {
    expect(noneSandbox().describe()).toContain('no isolation')
  })
})

describe('bubblewrapSandbox', () => {
  const args = (overrides = {}) => bubblewrapSandbox().wrap({ ...spec, ...overrides }).args

  it('binds the filesystem read-only and the workspace writable', () => {
    const wrapped = args()
    expect(wrapped.join(' ')).toContain('--ro-bind / /')
    expect(wrapped.join(' ')).toContain('--bind /work /work')
  })

  it('binds the workspace after the /tmp tmpfs, so a workspace under /tmp survives it', () => {
    const wrapped = args()
    expect(wrapped.indexOf('--tmpfs')).toBeLessThan(wrapped.indexOf('--bind'))
  })

  it('starts in the requested directory', () => {
    expect(args().join(' ')).toContain('--chdir /work/sub')
  })

  it('unshares the network by default and not when the network is allowed', () => {
    expect(args()).toContain('--unshare-net')
    expect(args({ network: true })).not.toContain('--unshare-net')
  })

  it('dies with the agent rather than outliving it', () => {
    expect(args()).toContain('--die-with-parent')
  })

  it('puts the command after the -- separator', () => {
    const wrapped = args()
    expect(wrapped.slice(wrapped.indexOf('--'))).toEqual(['--', '/bin/sh', '-c', 'echo hi'])
  })

  it('takes an alternative binary path', () => {
    expect(bubblewrapSandbox({ binary: '/opt/bwrap' }).wrap(spec).file).toBe('/opt/bwrap')
  })
})

describe('dockerSandbox', () => {
  const args = (overrides = {}, options = {}) => dockerSandbox(options).wrap({ ...spec, ...overrides }).args

  it('mounts the workspace at the same absolute path it has on the host', () => {
    // So a path the model got from read_file still resolves when it hands
    // that path to run_command.
    expect(args().join(' ')).toContain('--volume /work:/work')
    expect(args().join(' ')).toContain('--workdir /work/sub')
  })

  it('removes the container and drops every capability', () => {
    const wrapped = args().join(' ')
    expect(wrapped).toContain('--rm')
    expect(wrapped).toContain('--cap-drop ALL')
    expect(wrapped).toContain('no-new-privileges')
  })

  it('caps processes and memory', () => {
    expect(args().join(' ')).toContain('--pids-limit 512')
    expect(args({}, { pidsLimit: 64, memory: '512m' }).join(' ')).toContain('--pids-limit 64')
    expect(args({}, { memory: '512m' }).join(' ')).toContain('--memory 512m')
  })

  it('cuts the network by default and bridges it when allowed', () => {
    expect(args().join(' ')).toContain('--network none')
    expect(args({ network: true }).join(' ')).toContain('--network bridge')
  })

  it('runs as the agent, so workspace files are not left owned by root', () => {
    // --cap-drop ALL takes CAP_DAC_OVERRIDE with it, so a root process could
    // not write to the user's directory even if we wanted it to.
    expect(args({}, { user: '1000:1000' }).join(' ')).toContain('--user 1000:1000')
  })

  it('uses the default image, or the one it was given', () => {
    expect(args()).toContain('alpine:3.20')
    expect(args({}, { image: 'node:22-alpine' })).toContain('node:22-alpine')
  })

  it('puts the image immediately before the command', () => {
    const wrapped = args({}, { image: 'node:22-alpine' })
    expect(wrapped.slice(wrapped.indexOf('node:22-alpine'))).toEqual(['node:22-alpine', '/bin/sh', '-c', 'echo hi'])
  })
})

describe('selectSandbox', () => {
  it('returns the none backend when it is asked for by name', async () => {
    expect((await selectSandbox('none'))?.name).toBe('none')
  })

  it('returns nothing rather than falling back to none when a backend is unavailable', async () => {
    // The whole point: an unsandboxed shell has to be chosen, never inherited
    // from a missing binary.
    const chosen = await selectSandbox('bubblewrap', { bubblewrap: { binary: '/nonexistent/bwrap' } })
    expect(chosen).toBeUndefined()
  })

  it('never yields none from auto', async () => {
    const chosen = await selectSandbox('auto', {
      bubblewrap: { binary: '/nonexistent/bwrap' },
      docker: { binary: '/nonexistent/docker' },
    })
    expect(chosen).toBeUndefined()
  })

  it('probes by running, so an installed but unusable backend is rejected', async () => {
    // `false` exists and exits non-zero, standing in for a bwrap that is
    // present but denied the namespaces it needs.
    expect(await selectSandbox('bubblewrap', { bubblewrap: { binary: 'false' } })).toBeUndefined()
  })
})

/**
 * The real thing, against whichever backend this machine can actually run.
 *
 * Probed at module load rather than in a `beforeAll`, because `it.skipIf`
 * evaluates its condition while collecting the suite — before any hook has
 * run. Deciding in a hook silently skips every one of these regardless of
 * what is installed, which is a worse failure than the one being fixed: it
 * looks like a green suite either way.
 *
 * Reported as skipped rather than passed, so "verified" and "did nothing"
 * cannot be confused in the one suite where the difference matters most.
 */
const available = await selectSandbox('auto')
if (!available) {
  console.warn('[sandbox] no backend available here; the real-sandbox tests will be skipped, not verified')
}

describe('a real sandbox', () => {
  let root: string
  let outside: string

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'sandbox-ws-'))
    outside = await fs.mkdtemp(path.join(os.tmpdir(), 'sandbox-outside-'))
    await fs.writeFile(path.join(outside, 'secret.txt'), 'do not read me')
  })

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
    await fs.rm(outside, { recursive: true, force: true })
  })

  const run = async (command: string, network = false) => {
    return execute({
      command,
      cwd: root,
      workspaceRoot: root,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
      timeoutMs: 60_000,
      maxOutputBytes: 64_000,
      signal: new AbortController().signal,
      sandbox: available!,
      network,
    })
  }

  it.skipIf(!available)('runs a command and returns its output', async () => {
    expect((await run('echo hello')).stdout.trim()).toBe('hello')
  })

  it.skipIf(!available)('can write inside the workspace', async () => {
    const result = await run('echo written > marker.txt && cat marker.txt')
    expect(result.stdout.trim()).toBe('written')
  })

  it.skipIf(!available)('cannot read a file outside the workspace', async () => {
    const result = await run(`cat ${path.join(outside, 'secret.txt')}`)
    expect(result.stdout).not.toContain('do not read me')
    expect(result.code).not.toBe(0)
  })

  it.skipIf(!available)(
    'cannot reach the network by default',
    async () => {
      // Any of "no such host", "network unreachable" or a non-zero exit will
      // do; what matters is that the bytes did not come back.
      const result = await run('wget -q -T 3 -O - http://example.com || echo BLOCKED')
      expect(result.stdout).toContain('BLOCKED')
    },
    30_000,
  )
})
