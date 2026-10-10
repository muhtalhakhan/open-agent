import { describe, expect, it } from 'vitest'
import { KeychainSecretStore, MemorySecretStore, type CommandResult, type RunCommand } from './keychain.js'

/** Answers each command from a table, and records what was run. */
function fakeRun(answer: (command: string, args: string[]) => Partial<CommandResult>) {
  const calls: Array<[string, string[]]> = []
  const inputs: Array<string | undefined> = []
  const run: RunCommand = (command, args, input) => {
    calls.push([command, args])
    inputs.push(input)
    return { status: 0, stdout: '', stderr: '', ...answer(command, args) }
  }
  return { run, calls, inputs }
}

const enoent = Object.assign(new Error('spawn secret-tool ENOENT'), { code: 'ENOENT' })

describe('KeychainSecretStore on macOS', () => {
  it('looks the key up by service and account, and strips the trailing newline', () => {
    const { run, calls } = fakeRun(() => ({ stdout: 'sk-abc123\n' }))
    const store = new KeychainSecretStore({ platform: 'darwin', run })

    expect(store.get('OPENAI_API_KEY')).toBe('sk-abc123')
    expect(calls).toEqual([['security', ['find-generic-password', '-s', 'open-agent', '-a', 'OPENAI_API_KEY', '-w']]])
  })

  it('reports a missing entry as undefined, not an error', () => {
    const { run } = fakeRun(() => ({
      status: 44,
      stderr: 'security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.\n',
    }))
    expect(new KeychainSecretStore({ platform: 'darwin', run }).get('NOPE')).toBeUndefined()
  })

  it('throws when the keychain refuses, naming the key and never a value', () => {
    const { run } = fakeRun(() => ({ status: 51, stderr: 'User interaction is not allowed.\n' }))
    expect(() => new KeychainSecretStore({ platform: 'darwin', run }).get('OPENAI_API_KEY')).toThrow(
      'the macOS keychain refused OPENAI_API_KEY: User interaction is not allowed.',
    )
  })

  it('uses a configured service name', () => {
    const { run, calls } = fakeRun(() => ({ stdout: 'v\n' }))
    const store = new KeychainSecretStore({ platform: 'darwin', service: 'work-agent', run })
    store.get('K')
    expect(calls[0][1]).toContain('work-agent')
    expect(store.name).toBe('keychain (service "work-agent")')
  })
})

describe('KeychainSecretStore on Linux', () => {
  it('looks the key up through secret-tool', () => {
    const { run, calls } = fakeRun(() => ({ stdout: 'tok\n' }))
    expect(new KeychainSecretStore({ platform: 'linux', run }).get('GITHUB_TOKEN')).toBe('tok')
    expect(calls).toEqual([['secret-tool', ['lookup', 'service', 'open-agent', 'account', 'GITHUB_TOKEN']]])
  })

  it('tells "no such item" apart from "no Secret Service"', () => {
    const missing = fakeRun(() => ({ status: 1, stderr: '' }))
    expect(new KeychainSecretStore({ platform: 'linux', run: missing.run }).get('K')).toBeUndefined()

    const unreachable = fakeRun(() => ({ status: 1, stderr: 'Cannot autolaunch D-Bus without X11 $DISPLAY\n' }))
    expect(() => new KeychainSecretStore({ platform: 'linux', run: unreachable.run }).get('K')).toThrow(
      /Secret Service refused K: Cannot autolaunch D-Bus/,
    )
  })

  it('says how to get secret-tool when it is not installed', () => {
    const { run } = fakeRun(() => ({ status: null, error: enoent }))
    expect(() => new KeychainSecretStore({ platform: 'linux', run }).get('K')).toThrow(/install libsecret-tools/)
  })
})

describe('KeychainSecretStore.set', () => {
  it('stores through secret-tool with the value on stdin, never in the arguments', () => {
    const { run, calls, inputs } = fakeRun(() => ({}))
    new KeychainSecretStore({ platform: 'linux', run }).set('OPENAI_API_KEY', 'sk-secret-value')

    expect(calls).toEqual([
      [
        'secret-tool',
        ['store', '--label=open-agent OPENAI_API_KEY', 'service', 'open-agent', 'account', 'OPENAI_API_KEY'],
      ],
    ])
    expect(inputs).toEqual(['sk-secret-value'])
  })

  it('stores through security -i on macOS, with the value on stdin', () => {
    const { run, calls, inputs } = fakeRun(() => ({}))
    new KeychainSecretStore({ platform: 'darwin', run }).set('OPENAI_API_KEY', 'sk-secret-value')

    expect(calls).toEqual([['security', ['-i']]])
    expect(calls.flat(2).join(' ')).not.toContain('sk-secret-value')
    expect(inputs).toEqual(['add-generic-password -U -s "open-agent" -a "OPENAI_API_KEY" -w "sk-secret-value"\n'])
  })

  it('refuses, on macOS, a value it cannot quote safely', () => {
    const { run, calls } = fakeRun(() => ({}))
    expect(() => new KeychainSecretStore({ platform: 'darwin', run }).set('K', 'a"b')).toThrow(/quote, backslash/)
    expect(calls).toEqual([])
  })

  it('treats anything on stderr from security -i as a failure, since it exits 0 regardless', () => {
    const { run } = fakeRun(() => ({ stderr: 'SecKeychainItemCreateFromContent: User canceled\n' }))
    expect(() => new KeychainSecretStore({ platform: 'darwin', run }).set('K', 'v')).toThrow(/refused to store K/)
  })

  it('throws when the Secret Service refuses, naming the key and never the value', () => {
    const { run } = fakeRun(() => ({ status: 1, stderr: 'Cannot autolaunch D-Bus without X11\n' }))
    let message = ''
    try {
      new KeychainSecretStore({ platform: 'linux', run }).set('OPENAI_API_KEY', 'sk-secret-value')
    } catch (err) {
      message = (err as Error).message
    }
    expect(message).toMatch(/refused to store OPENAI_API_KEY: Cannot autolaunch/)
    expect(message).not.toContain('sk-secret-value')
  })

  it('isInstalled() is false only when the tool is missing', () => {
    expect(new KeychainSecretStore({ platform: 'linux', run: fakeRun(() => ({ status: 2 })).run }).isInstalled()).toBe(
      true,
    )
    expect(
      new KeychainSecretStore({
        platform: 'linux',
        run: fakeRun(() => ({ status: null, error: enoent })).run,
      }).isInstalled(),
    ).toBe(false)
  })
})

describe('KeychainSecretStore elsewhere', () => {
  it('refuses a platform it has no keychain tool for', () => {
    expect(() => new KeychainSecretStore({ platform: 'win32' })).toThrow(/macOS and Linux, not win32/)
  })
})

describe('MemorySecretStore', () => {
  it('answers from what it was given', () => {
    const store = new MemorySecretStore({ A: '1' })
    expect(store.get('A')).toBe('1')
    expect(store.get('B')).toBeUndefined()
  })
})
