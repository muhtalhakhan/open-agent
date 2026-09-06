import { describe, expect, it } from 'vitest'
import type { Logger } from '@open-agent/agent'
import { createRedactingLogger } from './redacting-logger.js'

interface Entry {
  level: 'info' | 'warn' | 'error'
  event: string
  data?: Record<string, unknown>
}

function recordingLogger(): { logger: Logger; entries: Entry[] } {
  const entries: Entry[] = []
  return {
    entries,
    logger: {
      info: (event, data) => entries.push({ level: 'info', event, data }),
      warn: (event, data) => entries.push({ level: 'warn', event, data }),
      error: (event, data) => entries.push({ level: 'error', event, data }),
    },
  }
}

describe('createRedactingLogger', () => {
  it('redacts a secret from the event name and from nested data', () => {
    const { logger, entries } = recordingLogger()
    const redacting = createRedactingLogger(logger, ['sk-live-secret'])

    redacting.info('call failed for sk-live-secret', {
      headers: { authorization: 'Bearer sk-live-secret' },
      attempts: [{ body: 'key sk-live-secret rejected' }],
      status: 401,
    })

    expect(entries[0]).toEqual({
      level: 'info',
      event: 'call failed for [REDACTED]',
      data: {
        headers: { authorization: 'Bearer [REDACTED]' },
        attempts: [{ body: 'key [REDACTED] rejected' }],
        status: 401,
      },
    })
  })

  it.each(['info', 'warn', 'error'] as const)('redacts at the %s level too', (level) => {
    const { logger, entries } = recordingLogger()
    createRedactingLogger(logger, ['sk-live-secret'])[level]('saw sk-live-secret')
    expect(entries[0]).toEqual({ level, event: 'saw [REDACTED]', data: undefined })
  })

  it('returns the logger untouched when there is nothing to redact', () => {
    const { logger } = recordingLogger()
    expect(createRedactingLogger(logger, [])).toBe(logger)
  })

  it('leaves a class instance intact rather than flattening it into a bare object', () => {
    const { logger, entries } = recordingLogger()
    const err = new Error('boom')

    createRedactingLogger(logger, ['sk-live-secret']).error('failed', { err })

    expect(entries[0].data?.err).toBe(err)
  })

  it('survives a cyclic structure', () => {
    const { logger, entries } = recordingLogger()
    const data: Record<string, unknown> = { note: 'sk-live-secret' }
    data.self = data

    createRedactingLogger(logger, ['sk-live-secret']).info('cycle', data)

    expect((entries[0].data as { note: string }).note).toBe('[REDACTED]')
  })
})
