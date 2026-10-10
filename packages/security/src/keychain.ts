import { spawnSync } from 'node:child_process'

/**
 * Somewhere secrets live other than the environment. Synchronous because
 * credentials are resolved while the configuration is parsed, before anything
 * else starts.
 */
export interface SecretStore {
  /** Names the store in error messages: "keychain", say. Never a value. */
  readonly name: string
  /**
   * The secret stored under `key`, or `undefined` when there is none.
   *
   * @throws when the store itself cannot be read (not installed, locked, access
   * denied), so an operator who asked for it learns so rather than silently
   * running without the credential.
   */
  get(key: string): string | undefined
}

/** What a spawned lookup returns. Injectable so tests never touch a real keychain. */
export interface CommandResult {
  status: number | null
  stdout: string
  stderr: string
  /** Set when the command could not be started at all (ENOENT, a timeout). */
  error?: Error
}

/**
 * `input` is written to the command's stdin. It is how a secret reaches a
 * command that stores it: an argument would be visible to every user on the
 * machine in `ps` for as long as the command runs.
 */
export type RunCommand = (command: string, args: string[], input?: string) => CommandResult

export interface KeychainOptions {
  /** The service the entries are filed under (default `open-agent`). */
  service?: string
  /** Defaults to the running platform. */
  platform?: NodeJS.Platform
  run?: RunCommand
}

/**
 * How long a lookup may take. Generous, because the OS may put an unlock or
 * "allow access" dialog in front of the user before it answers.
 */
const LOOKUP_TIMEOUT_MS = 60_000

const defaultRun: RunCommand = (command, args, input) => {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: LOOKUP_TIMEOUT_MS, input })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', error: result.error }
}

/**
 * Reads secrets from the operating system's credential store — the macOS
 * Keychain through `security`, or the freedesktop Secret Service (GNOME
 * Keyring, KWallet) through libsecret's `secret-tool` on Linux.
 *
 * Why bother when `.env` works: a key in `.env` is plaintext on disk, in every
 * backup, and one `git add .` from a public repository. A keychain entry is
 * encrypted at rest and released only to a logged-in user. Both platforms'
 * tools are driven through their CLIs rather than native bindings, so there
 * is nothing to compile, and a missing tool is an error message rather than a
 * failed install.
 *
 * Entries are looked up by service and account: the service is `open-agent`
 * unless configured otherwise, and the account is the variable's name, so
 * `OPENAI_API_KEY` in the keychain stands in for `OPENAI_API_KEY` in the env.
 */
export class KeychainSecretStore implements SecretStore {
  readonly name: string
  private readonly service: string
  private readonly platform: NodeJS.Platform
  private readonly run: RunCommand

  constructor(options: KeychainOptions = {}) {
    this.service = options.service ?? 'open-agent'
    this.platform = options.platform ?? process.platform
    this.run = options.run ?? defaultRun
    if (this.platform !== 'darwin' && this.platform !== 'linux') {
      throw new Error(`The keychain secret store supports macOS and Linux, not ${this.platform}.`)
    }
    this.name = `keychain (service "${this.service}")`
  }

  get(key: string): string | undefined {
    return this.platform === 'darwin' ? this.fromMacKeychain(key) : this.fromSecretService(key)
  }

  /**
   * Stores `value` under `key`, replacing any entry already there. The value
   * travels on stdin, never as an argument.
   *
   * @throws when the store refuses or cannot be reached, naming the key and
   * never the value.
   */
  set(key: string, value: string): void {
    if (this.platform === 'darwin') this.toMacKeychain(key, value)
    else this.toSecretService(key, value)
  }

  /**
   * Whether the platform's keychain tool is installed — enough to offer the
   * keychain, not a promise it will accept a write: a Secret Service that is
   * not running only shows itself when asked to store something.
   */
  isInstalled(): boolean {
    const result = this.run(this.platform === 'darwin' ? 'security' : 'secret-tool', ['--help'])
    return (result.error as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT'
  }

  private toMacKeychain(key: string, value: string): void {
    // `security add-generic-password -w <value>` would put the value in `ps`,
    // and a bare `-w` prompts on the terminal rather than reading stdin. Its
    // interactive mode reads whole commands from stdin, which keeps the value
    // off the command line; quoting there has no documented escape, so a
    // value that would need one is refused rather than guessed at. API keys
    // never contain these.
    for (const [label, text] of [
      ['service', this.service],
      ['key', key],
      ['value', value],
    ]) {
      if (/["\\\n\r]/.test(text))
        throw new Error(
          `cannot store ${key} in the macOS keychain: its ${label} contains a quote, backslash or newline`,
        )
    }
    const command = `add-generic-password -U -s "${this.service}" -a "${key}" -w "${value}"\n`
    const result = this.run('security', ['-i'], command)
    this.throwIfNotStarted(result, 'security')
    // `security -i` exits 0 even when a command in it fails, and reports the
    // failure on stderr instead.
    if (result.status !== 0 || result.stderr.trim()) {
      throw new Error(
        `the macOS keychain refused to store ${key}: ${firstLine(result.stderr) || `exit ${result.status}`}`,
      )
    }
  }

  private toSecretService(key: string, value: string): void {
    const result = this.run(
      'secret-tool',
      ['store', `--label=open-agent ${key}`, 'service', this.service, 'account', key],
      value,
    )
    this.throwIfNotStarted(result, 'secret-tool')
    if (result.status !== 0) {
      throw new Error(
        `the Secret Service refused to store ${key}: ${firstLine(result.stderr) || `exit ${result.status}`}`,
      )
    }
  }

  private fromMacKeychain(key: string): string | undefined {
    const result = this.run('security', ['find-generic-password', '-s', this.service, '-a', key, '-w'])
    this.throwIfNotStarted(result, 'security')
    if (result.status === 0) return result.stdout.replace(/\n$/, '')
    // 44 is errSecItemNotFound: a lookup that worked and found nothing.
    if (result.status === 44) return undefined
    throw new Error(`the macOS keychain refused ${key}: ${firstLine(result.stderr) || `exit ${result.status}`}`)
  }

  private fromSecretService(key: string): string | undefined {
    const result = this.run('secret-tool', ['lookup', 'service', this.service, 'account', key])
    this.throwIfNotStarted(result, 'secret-tool')
    if (result.status === 0) return result.stdout.replace(/\n$/, '')
    // secret-tool exits 1 with nothing on stderr for "no such item", and with
    // a message when the Secret Service itself could not be reached.
    if (result.status === 1 && result.stderr.trim() === '') return undefined
    throw new Error(`the Secret Service refused ${key}: ${firstLine(result.stderr) || `exit ${result.status}`}`)
  }

  private throwIfNotStarted(result: CommandResult, command: string): void {
    if (!result.error) return
    const missing = (result.error as NodeJS.ErrnoException).code === 'ENOENT'
    throw new Error(
      missing
        ? `${command} was not found; ${command === 'secret-tool' ? 'install libsecret-tools' : 'it ships with macOS'} to use the keychain.`
        : `${command} could not be run: ${result.error.message}`,
    )
  }
}

/** Holds secrets in memory, for tests and for callers that fetch them some other way. */
export class MemorySecretStore implements SecretStore {
  readonly name = 'memory'
  private readonly secrets: Map<string, string>

  constructor(secrets: Record<string, string> = {}) {
    this.secrets = new Map(Object.entries(secrets))
  }

  get(key: string): string | undefined {
    return this.secrets.get(key)
  }
}

function firstLine(text: string): string {
  return text.trim().split('\n')[0] ?? ''
}
