import { describe, expect, it } from 'vitest'
import { parseWhen } from './when.js'

/** A fixed reference point: Wednesday 2026-09-09, 14:30 in New York (18:30Z). */
const NOW = Date.parse('2026-09-09T18:30:00Z')
const NY = 'America/New_York'

/** The parsed result, rendered as wall-clock in a zone, for readable assertions. */
function inZone(ts: number, timeZone = NY): string {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(ts))
}

const when = (input: string, timeZone = NY) => parseWhen(input, { now: NOW, timeZone })

describe('parseWhen', () => {
  describe('ISO timestamps', () => {
    it('takes an explicit offset at face value', () => {
      expect(when('2026-09-10T09:00:00Z')).toBe(Date.parse('2026-09-10T09:00:00Z'))
      expect(when('2026-09-10T09:00:00+02:00')).toBe(Date.parse('2026-09-10T09:00:00+02:00'))
    })

    it('reads a bare datetime as wall-clock in the given zone', () => {
      expect(when('2026-09-10T09:00')).toBe(Date.parse('2026-09-10T13:00:00Z')) // EDT is UTC-4
      expect(when('2026-09-10 09:00')).toBe(Date.parse('2026-09-10T13:00:00Z'))
    })

    it('reads a bare date as the start of that day', () => {
      expect(inZone(when('2026-09-10'))).toBe('2026-09-10 00:00')
    })

    it('accepts a date in the past, since naming one is unambiguous', () => {
      expect(when('2020-01-01T00:00:00Z')).toBe(Date.parse('2020-01-01T00:00:00Z'))
    })
  })

  describe('durations', () => {
    it('reads "in", "+" and bare forms alike', () => {
      expect(when('in 30 minutes')).toBe(NOW + 30 * 60_000)
      expect(when('+30m')).toBe(NOW + 30 * 60_000)
      expect(when('45m')).toBe(NOW + 45 * 60_000)
    })

    it('sums compound durations', () => {
      expect(when('+2h30m')).toBe(NOW + 2 * 3_600_000 + 30 * 60_000)
      expect(when('in 1 day 6 hours')).toBe(NOW + 86_400_000 + 6 * 3_600_000)
    })

    it('accepts the spellings people actually type', () => {
      expect(when('in 2 hours')).toBe(when('in 2h'))
      expect(when('in 1 week')).toBe(when('in 7 days'))
    })
  })

  describe('clock times', () => {
    it('rolls a time that has already passed today to tomorrow', () => {
      // 14:30 local now, so 9am is behind us.
      expect(inZone(when('at 9am'))).toBe('2026-09-10 09:00')
    })

    it('keeps a time still ahead today', () => {
      expect(inZone(when('at 9pm'))).toBe('2026-09-09 21:00')
      expect(inZone(when('21:30'))).toBe('2026-09-09 21:30')
    })

    it('reads noon and midnight', () => {
      expect(inZone(when('midnight'))).toBe('2026-09-10 00:00')
      expect(inZone(when('noon'))).toBe('2026-09-10 12:00')
    })

    it('handles the 12am/12pm corner', () => {
      expect(inZone(when('12am'))).toBe('2026-09-10 00:00')
      expect(inZone(when('12pm'))).toBe('2026-09-10 12:00')
    })
  })

  describe('days', () => {
    it('reads today and tomorrow', () => {
      expect(inZone(when('today at 9pm'))).toBe('2026-09-09 21:00')
      expect(inZone(when('tomorrow at 9am'))).toBe('2026-09-10 09:00')
      expect(inZone(when('tomorrow'))).toBe('2026-09-10 00:00')
    })

    it('resolves a weekday to its next occurrence', () => {
      // NOW is a Wednesday.
      expect(inZone(when('friday 17:00'))).toBe('2026-09-11 17:00')
      expect(inZone(when('next monday'))).toBe('2026-09-14 00:00')
    })

    it('treats the current weekday as the one coming, not today', () => {
      expect(inZone(when('wednesday at 9pm'))).toBe('2026-09-16 21:00')
    })
  })

  describe('time zones', () => {
    it('resolves the same wall clock to different instants per zone', () => {
      const ny = parseWhen('tomorrow at 9am', { now: NOW, timeZone: NY })
      const tokyo = parseWhen('tomorrow at 9am', { now: NOW, timeZone: 'Asia/Tokyo' })
      expect(ny).not.toBe(tokyo)
      expect(inZone(ny)).toBe('2026-09-10 09:00')
      // NOW is already 03:30 on the 10th in Tokyo, so "tomorrow" is the 11th
      // there while it is still the 10th in New York.
      expect(inZone(tokyo, 'Asia/Tokyo')).toBe('2026-09-11 09:00')
    })

    it('keeps a wall-clock time across a DST boundary', () => {
      // US clocks spring forward on 2027-03-14. 9am the day after is still 9am,
      // even though the offset changed underneath it.
      const before = Date.parse('2027-03-13T12:00:00Z')
      const result = parseWhen('tomorrow at 9am', { now: before, timeZone: NY })
      expect(inZone(result)).toBe('2027-03-14 09:00')
      // Which is 13:00Z under EDT, not the 14:00Z a stored EST offset would give.
      expect(result).toBe(Date.parse('2027-03-14T13:00:00Z'))
    })

    it('resolves a wall clock that DST skips to the first real time after it', () => {
      // 02:30 on 2027-03-14 does not exist in New York; clocks jump 02:00 → 03:00.
      const result = parseWhen('2027-03-14T02:30', { timeZone: NY })
      expect(inZone(result)).toBe('2027-03-14 03:30')
    })
  })

  describe('rejections', () => {
    it.each([
      ['', 'a time is required'],
      ['sometime soon', /could not read/],
      ['30', /could not read/],
      ['25:00', /could not read/],
      ['9:99', /could not read/],
      ['13pm', /could not read/],
      ['in 5 fortnights', /could not read/],
    ])('rejects %j', (input, message) => {
      expect(() => when(input)).toThrow(message)
    })

    it('names the forms it accepts, so the error is actionable', () => {
      expect(() => when('whenever')).toThrow(/ISO timestamp.*duration.*clock time.*day and time/s)
    })
  })
})
