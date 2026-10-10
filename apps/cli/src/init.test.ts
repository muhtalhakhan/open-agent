import { describe, expect, it } from 'vitest'
import { renderEnv, runInit, type InitDeps, type KeychainWriter, type LlmSettings } from './init.js'

const KEY = 'sk-live-0123456789abcdef'

/**
 * Answers questions in order from a script. Secret questions take from the
 * same script, so a test reads top to bottom as the session would.
 */
function scripted(answers: string[]) {
  const queue = [...answers]
  const output: string[] = []
  const secretQuestions: string[] = []
  const next = () => (queue.length ? queue.shift()! : null)
  return {
    output,
    secretQuestions,
    text: () => output.join(''),
    io: {
      ask: async (question: string) => (output.push(question), next()),
      askSecret: async (question: string) => (secretQuestions.push(question), output.push(question), next()),
      write: (text: string) => void output.push(text),
    },
  }
}

function deps(overrides: Partial<InitDeps> = {}) {
  const written: Array<{ path: string; content: string }> = []
  const checked: LlmSettings[] = []
  const stored: Record<string, string> = {}
  const keychain: KeychainWriter = {
    name: 'keychain (service "open-agent")',
    isInstalled: () => true,
    set: (key, value) => void (stored[key] = value),
  }
  return {
    written,
    checked,
    stored,
    deps: {
      envPath: '/repo/.env',
      exists: () => false,
      writeEnv: (path: string, content: string) => void written.push({ path, content }),
      check: async (llm: LlmSettings) => void checked.push(llm),
      keychain,
      cwd: '/work',
      ...overrides,
    } satisfies InitDeps,
  }
}

/** Provider 1, default model, the key, then "no" to every tool. */
const OPENAI_NO_TOOLS = ['1', '', KEY, 'n', 'n', 'n', 'n', 'n']

describe('runInit', () => {
  it('puts the key in the keychain, and .env points there', async () => {
    const s = scripted([...OPENAI_NO_TOOLS, '', ''])
    const d = deps()

    expect(await runInit(s.io, d.deps)).toBe(0)

    expect(d.stored).toEqual({ OPENAI_API_KEY: KEY })
    expect(d.written).toHaveLength(1)
    const env = d.written[0].content
    expect(env).toContain('OPENAI_BASE_URL=https://api.openai.com/v1\n')
    expect(env).toContain('OPENAI_MODEL=gpt-4o-mini\n')
    expect(env).toContain('SECRET_STORE=keychain\n')
    expect(env).not.toContain(KEY)
  })

  it('checks the model with the settings given before writing anything', async () => {
    const s = scripted([...OPENAI_NO_TOOLS, '', ''])
    const d = deps()
    await runInit(s.io, d.deps)
    expect(d.checked).toEqual([{ baseURL: 'https://api.openai.com/v1', apiKey: KEY, model: 'gpt-4o-mini' }])
  })

  it('asks for the key without echo, and never prints it back — not even in an error', async () => {
    const s = scripted(['1', '', KEY, 'n', 'n', ...['n', 'n', 'n', 'n', 'n'], '', ''])
    const d = deps({ check: async () => `401 Unauthorized: bad key ${KEY}` })
    // Check fails; "try again?" no; "save anyway?" no -> cancelled.
    const code = await runInit(s.io, d.deps)

    expect(s.secretQuestions).toEqual(['API key (not shown as you type): '])
    expect(s.text()).not.toContain(KEY)
    expect(s.text()).toContain('[REDACTED]')
    expect(code).toBe(1)
    expect(d.written).toEqual([])
  })

  it('writes the key into .env when there is no keychain', async () => {
    const s = scripted([...OPENAI_NO_TOOLS, ''])
    const d = deps({ keychain: undefined })

    await runInit(s.io, d.deps)

    expect(d.written[0].content).toContain(`OPENAI_API_KEY=${KEY}\n`)
    expect(d.written[0].content).not.toContain('SECRET_STORE')
    expect(s.text()).not.toContain(KEY)
  })

  it('falls back to .env, if asked, when the keychain refuses — before writing anything else', async () => {
    const s = scripted([...OPENAI_NO_TOOLS, '', '', 'y'])
    const d = deps({
      keychain: {
        name: 'keychain',
        isInstalled: () => true,
        set: () => {
          throw new Error('the Secret Service refused to store OPENAI_API_KEY: no D-Bus')
        },
      },
    })

    expect(await runInit(s.io, d.deps)).toBe(0)
    expect(s.text()).toContain('The keychain refused')
    expect(d.written[0].content).toContain(`OPENAI_API_KEY=${KEY}`)
    expect(d.written[0].content).not.toContain('SECRET_STORE')
  })

  it('leaves an existing .env alone unless told to replace it', async () => {
    const s = scripted([''])
    const d = deps({ exists: () => true })

    expect(await runInit(s.io, d.deps)).toBe(0)
    expect(s.text()).toContain('Left it as it is.')
    expect(d.written).toEqual([])
  })

  it('writes nothing when input ends part-way', async () => {
    const s = scripted(['1', ''])
    const d = deps()

    expect(await runInit(s.io, d.deps)).toBe(1)
    expect(s.text()).toContain('Nothing was written.')
    expect(d.written).toEqual([])
    expect(d.stored).toEqual({})
  })

  it('writes nothing when the summary is declined', async () => {
    const s = scripted([...OPENAI_NO_TOOLS, '', 'n'])
    const d = deps()

    expect(await runInit(s.io, d.deps)).toBe(1)
    expect(d.written).toEqual([])
    expect(d.stored).toEqual({})
  })

  it('needs no key for a local server, and offers no keychain for its placeholder', async () => {
    // Ollama, default model, no tools, then the summary.
    const s = scripted(['5', '', 'n', 'n', 'n', 'n', 'n', ''])
    const d = deps()

    await runInit(s.io, d.deps)

    expect(s.secretQuestions).toEqual([])
    expect(d.stored).toEqual({})
    expect(d.written[0].content).toContain('OPENAI_BASE_URL=http://localhost:11434/v1\n')
    expect(d.written[0].content).toContain('OPENAI_API_KEY=ollama\n')
  })

  it('turns on the tools asked for, and keeps their keys out of .env too', async () => {
    const s = scripted([
      '1',
      'gpt-test',
      KEY,
      'y', // files
      '', // workspace: default
      'y', // shell
      '', // sandbox: auto
      'y', // search
      'tavily',
      'tvly-search-key',
      'y', // memory
      'mem0',
      'm0-memory-key',
      'n', // browser
      '', // keychain: yes
      '', // write: yes
    ])
    const d = deps()

    await runInit(s.io, d.deps)

    const env = d.written[0].content
    expect(env).toContain('OPENAI_MODEL=gpt-test\n')
    expect(env).toContain('FILES_TOOL=1\nFILES_ROOT=/work\n')
    expect(env).toContain('SHELL_TOOL=1\nSHELL_SANDBOX=auto\n')
    expect(env).not.toContain('BROWSER_USE')
    expect(d.stored).toEqual({ OPENAI_API_KEY: KEY, TAVILY_API_KEY: 'tvly-search-key', MEM0_API_KEY: 'm0-memory-key' })
    expect(env).not.toMatch(/tvly-search-key|m0-memory-key/)
    expect(s.secretQuestions).toHaveLength(3)
  })

  it('refuses a value .env cannot hold before storing anything anywhere', async () => {
    const s = scripted(['1', '', `it's"odd`, 'n', 'n', 'n', 'n', 'n', ''])
    const d = deps()

    expect(await runInit(s.io, d.deps)).toBe(1)
    expect(s.text()).toContain('cannot hold')
    expect(d.stored).toEqual({})
    expect(d.written).toEqual([])
  })

  it('takes a second, explicit yes before running shell commands unsandboxed', async () => {
    const answers = (sandbox: string[]) => ['1', '', KEY, 'n', 'y', ...sandbox, 'n', 'n', 'n', '']
    const backedOff = scripted(answers(['none', '', 'docker']))
    const insisted = scripted(answers(['none', 'y']))
    const typo = scripted(answers(['dokcer', 'bubblewrap']))
    const results = await Promise.all(
      [backedOff, insisted, typo].map(async (s) => {
        const d = deps({ keychain: undefined })
        await runInit(s.io, d.deps)
        return d.written[0]?.content.match(/SHELL_SANDBOX=(\w+)/)?.[1]
      }),
    )

    expect(results).toEqual(['docker', 'none', 'bubblewrap'])
    expect(backedOff.text()).toContain('commands run as you')
    expect(typo.text()).toContain('Pick auto, bubblewrap, docker or none.')
  })

  it('asks for the base URL when the endpoint is not a preset', async () => {
    const s = scripted(['7', 'https://llm.internal/v1', 'my-model', KEY, 'n', 'n', 'n', 'n', 'n', '', ''])
    const d = deps()

    await runInit(s.io, d.deps)

    expect(d.checked[0]).toEqual({ baseURL: 'https://llm.internal/v1', apiKey: KEY, model: 'my-model' })
  })
})

describe('renderEnv', () => {
  it('quotes only what dotenv would misread, and never changes a value', () => {
    expect(renderEnv([['A', 'plain']])).toContain('A=plain\n')
    expect(renderEnv([['A', 'has space']])).toContain("A='has space'\n")
    expect(renderEnv([['A', "it's"]])).toContain('A="it\'s"\n')
  })

  it('refuses what it cannot write faithfully', () => {
    expect(() => renderEnv([['A', 'two\nlines']])).toThrow(/line break/)
    expect(() => renderEnv([['A', `'"`]])).toThrow(/cannot hold/)
  })
})
