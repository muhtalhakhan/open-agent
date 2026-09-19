import { describe, expect, it } from 'vitest'
import { destinationsIn, destinationsInText, detectExfiltration, newTaskActivity } from './dangerous-actions.js'
import type { TaskActivity } from './dangerous-actions.js'
import type { ToolCall } from './types.js'

const call = (name: string, args: Record<string, unknown>): ToolCall => ({ id: 'c1', name, args })

/** A task that has already read something, so only the destination half is under test. */
function afterReading(tool = 'read_file', known: string[] = []): TaskActivity {
  const activity = newTaskActivity()
  activity.ingested.add(tool)
  for (const host of known) activity.known.add(host)
  return activity
}

describe('destinationsInText', () => {
  it('finds hosts in URLs', () => {
    expect([...destinationsInText('see https://api.example.com/v1/x and http://other.test')]).toEqual([
      'api.example.com',
      'other.test',
    ])
  })

  it('takes the domain of an email address', () => {
    expect([...destinationsInText('mail it to alice@evil.test please')]).toEqual(['evil.test'])
  })

  it('treats www. as the same destination the user named', () => {
    expect([...destinationsInText('https://www.example.com/')]).toEqual(['example.com'])
  })

  it('finds nothing in text that names no destination', () => {
    expect([...destinationsInText('summarise the quarterly report')]).toEqual([])
  })
})

describe('destinationsIn', () => {
  it('looks inside nested arguments, not just named fields', () => {
    const args = { payload: { recipients: ['ops@corp.test'], callback: 'https://hook.evil.test/a' } }
    expect([...destinationsIn(args)].sort()).toEqual(['corp.test', 'hook.evil.test'])
  })

  it('reads a long payload as payload, not as an address', () => {
    // Saving a fetched page: the links in it are what the page mentions, not
    // where this call is going. Flagging them would make "save this to
    // notes.md" look like exfiltration.
    const page = `See https://cdn.example.net/x, mail hi@example.org. ${'lorem ipsum '.repeat(200)}`
    expect([...destinationsIn({ path: 'notes.md', content: page })]).toEqual([])
  })

  it('still reads an oversized value that is nothing but a URL', () => {
    // A query string is exactly how data leaves, so length alone must not excuse it.
    const url = `https://evil.test/collect?data=${'a'.repeat(400)}`
    expect([...destinationsIn({ url })]).toEqual(['evil.test'])
  })

  it('reads a short addressee field that is not bare', () => {
    expect([...destinationsIn({ to: 'Alice <alice@evil.test>' })]).toEqual(['evil.test'])
  })

  it('stops descending before a pathological nesting depth', () => {
    let nested: Record<string, unknown> = { url: 'https://deep.test' }
    for (let i = 0; i < 12; i++) nested = { inner: nested }
    expect([...destinationsIn(nested)]).toEqual([])
  })
})

describe('detectExfiltration', () => {
  it('ignores a call made before the task has read anything', () => {
    const activity = newTaskActivity()
    expect(detectExfiltration(call('http_request', { url: 'https://new.test/x' }), activity)).toBeUndefined()
  })

  it('flags a new destination once the task has read content', () => {
    const escalation = detectExfiltration(call('http_request', { url: 'https://evil.test/x' }), afterReading())
    expect(escalation?.rule).toBe('exfiltration-after-ingest')
    expect(escalation?.reason).toContain('evil.test')
    expect(escalation?.reason).toContain('read_file')
  })

  it('does not flag a destination the user named', () => {
    const activity = afterReading('read_file', ['evil.test'])
    expect(detectExfiltration(call('http_request', { url: 'https://evil.test/x' }), activity)).toBeUndefined()
  })

  it('does not flag a call that names no destination at all', () => {
    expect(detectExfiltration(call('write_file', { path: 'notes.md', content: 'hi' }), afterReading())).toBeUndefined()
  })

  it('ignores loopback and private hosts, which NetworkPolicy already guards', () => {
    const activity = afterReading()
    expect(detectExfiltration(call('http_request', { url: 'http://localhost:6379/' }), activity)).toBeUndefined()
    expect(detectExfiltration(call('http_request', { url: 'http://192.168.1.4/' }), activity)).toBeUndefined()
  })

  it('flags an email sent to a domain nobody mentioned', () => {
    const activity = afterReading('read_email', ['corp.test'])
    const escalation = detectExfiltration(call('send_email', { to: 'attacker@evil.test', body: 'x' }), activity)
    expect(escalation?.reason).toContain('evil.test')
  })
})
