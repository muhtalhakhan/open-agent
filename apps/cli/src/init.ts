import { redactSecrets } from '@open-agent/providers'

/** How the wizard talks to a person. Injected, so it runs under test like the REPL does. */
export interface InitIO {
  /** The next answer, or `null` when input has ended (Ctrl+D, Ctrl+C). */
  ask(question: string): Promise<string | null>
  /** Like `ask`, but what is typed is not echoed. For keys. */
  askSecret(question: string): Promise<string | null>
  write(text: string): void
}

/** The OS keychain, as far as the wizard needs it. */
export interface KeychainWriter {
  /** Names it to the person: "keychain (service "open-agent")". */
  readonly name: string
  isInstalled(): boolean
  set(key: string, value: string): void
}

export interface LlmSettings {
  baseURL: string
  apiKey: string
  model: string
}

export interface InitDeps {
  /** Where the CLI reads `.env` from, and so where this writes it. */
  envPath: string
  exists(path: string): boolean
  /** Writes the file readable by its owner alone: it may hold keys. */
  writeEnv(path: string, content: string): void
  /** Makes one small request to the model. Resolves with an error message, or `undefined` if it answered. */
  check(llm: LlmSettings): Promise<string | undefined>
  /** Absent where there is no keychain to offer (Windows, say). */
  keychain?: KeychainWriter
  /** The default workspace for the file tools: where the wizard was started. */
  cwd: string
}

interface Preset {
  label: string
  baseURL: string
  model: string
  /** A local server takes any key; it is written as a placeholder, not asked for. */
  localKey?: string
}

/**
 * The CLI speaks the OpenAI chat-completions shape to every provider, so a
 * preset is only a base URL and a model to start from. Anthropic and Gemini
 * both serve that shape alongside their own APIs.
 */
export const PRESETS: Preset[] = [
  { label: 'OpenAI', baseURL: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { label: 'OpenRouter', baseURL: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4o-mini' },
  { label: 'Anthropic', baseURL: 'https://api.anthropic.com/v1', model: 'claude-sonnet-5-5' },
  {
    label: 'Google Gemini',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'gemini-2.5-flash',
  },
  { label: 'Ollama (local)', baseURL: 'http://localhost:11434/v1', model: 'llama3.2', localKey: 'ollama' },
  { label: 'LM Studio (local)', baseURL: 'http://localhost:1234/v1', model: 'local-model', localKey: 'lm-studio' },
]

/** Raised to unwind the wizard when input ends: nothing has been written, and nothing will be. */
class Cancelled extends Error {}

/**
 * `open-agent init`: asks what `.env` would otherwise have to be filled in
 * by hand for, checks the model answers, and writes the file.
 *
 * Three promises it keeps. A key is never echoed — not as it is typed, not in
 * the summary, not in an error. Nothing is written until the person has seen
 * a summary and said yes, so quitting part-way leaves no half-written config.
 * And an existing `.env` is never replaced without asking, since it may hold
 * settings this wizard doesn't know about.
 *
 * Keys go to the OS keychain when there is one, with `SECRET_STORE=keychain`
 * in `.env` to find them there: a key in `.env` is plaintext on disk and in
 * every backup.
 *
 * Returns an exit code.
 */
export async function runInit(io: InitIO, deps: InitDeps): Promise<number> {
  try {
    return await wizard(io, deps)
  } catch (err) {
    if (err instanceof Cancelled) {
      io.write('\nCancelled. Nothing was written.\n')
      return 1
    }
    throw err
  }
}

async function wizard(io: InitIO, deps: InitDeps): Promise<number> {
  const ask = async (question: string) => {
    const answer = await io.ask(question)
    if (answer === null) throw new Cancelled()
    return answer.trim()
  }
  const askSecret = async (question: string) => {
    const answer = await io.askSecret(question)
    if (answer === null) throw new Cancelled()
    return answer.trim()
  }
  const confirm = async (question: string, byDefault: boolean) => {
    for (;;) {
      const answer = (await ask(`${question} ${byDefault ? '[Y/n]' : '[y/N]'} `)).toLowerCase()
      if (!answer) return byDefault
      if (answer === 'y' || answer === 'yes') return true
      if (answer === 'n' || answer === 'no') return false
    }
  }
  const askRequired = async (question: string, secret = false) => {
    for (;;) {
      const answer = secret ? await askSecret(question) : await ask(question)
      if (answer) return answer
      io.write('  This one is needed.\n')
    }
  }

  io.write(`Setting up OpenAgent. Answers go into ${deps.envPath}; press Ctrl+C to stop without writing anything.\n\n`)

  if (deps.exists(deps.envPath)) {
    io.write(`${deps.envPath} already exists.\n`)
    if (!(await confirm('Replace it? Anything in it that you do not set again here is lost.', false))) {
      io.write('Left it as it is.\n')
      return 0
    }
  }

  // The model.
  io.write('\nWhich model provider?\n')
  PRESETS.forEach((preset, i) => io.write(`  ${i + 1}. ${preset.label}\n`))
  io.write(`  ${PRESETS.length + 1}. Another OpenAI-compatible endpoint\n`)
  let preset: Preset | undefined
  for (;;) {
    const answer = await ask('Provider [1]: ')
    const choice = answer ? Number(answer) : 1
    if (Number.isInteger(choice) && choice >= 1 && choice <= PRESETS.length + 1) {
      preset = PRESETS[choice - 1]
      break
    }
    io.write(`  Pick a number from 1 to ${PRESETS.length + 1}.\n`)
  }

  const baseURL = preset ? preset.baseURL : await askRequired('Base URL (e.g. https://host/v1): ')
  const model =
    (await ask(`Model${preset ? ` [${preset.model}]` : ''}: `)) || preset?.model || (await askRequired('Model: '))
  const apiKey = preset?.localKey ?? (await askRequired('API key (not shown as you type): ', true))
  const secretsTyped = preset?.localKey ? [] : [apiKey]

  for (;;) {
    io.write('\nChecking the model answers…\n')
    const failure = await deps.check({ baseURL, apiKey, model })
    if (failure === undefined) {
      io.write('  It does.\n')
      break
    }
    // The key is in a header rather than the URL, but providers echo
    // requests back in their error bodies often enough to scrub it anyway.
    // An error body can be a whole HTML page; the first few hundred
    // characters say what went wrong.
    const reason = redactSecrets(failure, secretsTyped).replace(/\s+/g, ' ')
    io.write(`  It did not: ${reason.length > 300 ? `${reason.slice(0, 299)}…` : reason}\n`)
    if (!(await confirm('Try again?', true))) {
      if (!(await confirm('Save these settings anyway?', false))) throw new Cancelled()
      break
    }
  }

  const env: Array<[string, string]> = [
    ['OPENAI_BASE_URL', baseURL],
    ['OPENAI_MODEL', model],
  ]
  const secrets: Array<[string, string]> = [['OPENAI_API_KEY', apiKey]]

  // Tools. Each is off unless asked for, as it is without a wizard.
  io.write('\nTools — each is off unless you turn it on.\n')
  if (await confirm('Let the agent read files, and write them with your approval?', false)) {
    const root = (await ask(`  Workspace it may see [${deps.cwd}]: `)) || deps.cwd
    env.push(['FILES_TOOL', '1'], ['FILES_ROOT', root])
  }
  if (await confirm('Let it run shell commands, each with your approval, inside a sandbox?', false)) {
    env.push(['SHELL_TOOL', '1'])
    io.write('  It picks bubblewrap or Docker, and turns the shell tools off if neither works (see SHELL_SANDBOX).\n')
  }
  if (await confirm('Give it web search (Brave or Tavily, needs an API key)?', false)) {
    const tavily = (await ask('  Brave or Tavily? [brave]: ')).toLowerCase().startsWith('t')
    const name = tavily ? 'TAVILY_API_KEY' : 'BRAVE_SEARCH_API_KEY'
    const key = await askRequired(`  ${tavily ? 'Tavily' : 'Brave Search'} API key (not shown): `, true)
    secrets.push([name, key])
    secretsTyped.push(key)
  }
  if (await confirm('Give it memory that lasts between sessions (Supermemory or Mem0, needs an API key)?', false)) {
    const mem0 = (await ask('  Supermemory or Mem0? [supermemory]: ')).toLowerCase().startsWith('m')
    const name = mem0 ? 'MEM0_API_KEY' : 'SUPERMEMORY_API_KEY'
    const key = await askRequired(`  ${mem0 ? 'Mem0' : 'Supermemory'} API key (not shown): `, true)
    secrets.push([name, key])
    secretsTyped.push(key)
  }
  if (await confirm('Enable the browser tools (needs `pip install browser-use`, Python 3.11+)?', false)) {
    env.push(['BROWSER_USE', '1'])
  }

  // Where the keys go. A local server's placeholder is not a secret, and
  // stays in .env with the rest.
  const realSecrets = preset?.localKey ? secrets.filter(([name]) => name !== 'OPENAI_API_KEY') : secrets
  let keychain: KeychainWriter | undefined
  if (realSecrets.length > 0 && deps.keychain?.isInstalled()) {
    io.write('\n')
    if (await confirm('Keep the keys in the OS keychain rather than in .env (recommended)?', true)) {
      keychain = deps.keychain
    }
  }

  // Checked now, with everything that could end up in the file, rather than
  // when it is written: by then the keys may already be in the keychain.
  try {
    renderEnv([...env, ...secrets])
  } catch (err) {
    io.write(`\n${err instanceof Error ? err.message : String(err)}. Set it by hand in .env instead.\n`)
    throw new Cancelled()
  }

  const inFile = new Set<string>(keychain ? [] : realSecrets.map(([name]) => name))
  if (preset?.localKey) inFile.add('OPENAI_API_KEY')

  io.write('\nAbout to write:\n')
  for (const [name, value] of env) io.write(`  ${name}=${value}\n`)
  for (const [name] of secrets) {
    if (name === 'OPENAI_API_KEY' && preset?.localKey)
      io.write(`  ${name}=${apiKey} (a local server needs no real key)\n`)
    else io.write(`  ${name}: ${inFile.has(name) ? 'in .env (not shown)' : `in the ${keychain?.name}`}\n`)
  }
  if (!(await confirm(`\nWrite ${deps.envPath}?`, true))) throw new Cancelled()

  // The keychain first: if it refuses, nothing has been written yet, and the
  // person can choose .env instead rather than ending up with a config that
  // points at a keychain entry that isn't there.
  if (keychain) {
    try {
      for (const [name, value] of realSecrets) keychain.set(name, value)
    } catch (err) {
      io.write(
        `\nThe keychain refused: ${redactSecrets(err instanceof Error ? err.message : String(err), secretsTyped)}\n`,
      )
      if (!(await confirm('Put the keys in .env instead?', false))) throw new Cancelled()
      keychain = undefined
      for (const [name] of realSecrets) inFile.add(name)
    }
  }

  const lines = [...env, ...secrets.filter(([name]) => inFile.has(name))]
  if (keychain) lines.push(['SECRET_STORE', 'keychain'])
  deps.writeEnv(deps.envPath, renderEnv(lines))

  io.write(`\nWrote ${deps.envPath}. Start with \`open-agent\`, or see .env.example for every other setting.\n`)
  return 0
}

/**
 * The file itself. Values are quoted only when dotenv would otherwise misread
 * them. dotenv has no escapes inside single quotes and expands `\n` inside
 * double ones, so a value is single-quoted when it can be, double-quoted when
 * it holds a `'` and no backslash, and refused otherwise — changing a key to
 * make it fit would write a config that silently fails to authenticate.
 */
export function renderEnv(entries: Array<[string, string]>): string {
  const lines = entries.map(([name, value]) => {
    if (/[\r\n]/.test(value)) throw new Error(`${name} contains a line break, which .env cannot hold`)
    if (!/[\s#"'`$\\]/.test(value)) return `${name}=${value}`
    if (!value.includes("'")) return `${name}='${value}'`
    if (!value.includes('"') && !value.includes('\\')) return `${name}="${value}"`
    throw new Error(`${name} has a ' together with a " or a backslash, which .env cannot hold`)
  })
  return `# Written by \`open-agent init\`. Every setting is described in .env.example.\n${lines.join('\n')}\n`
}
