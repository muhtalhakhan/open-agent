import { describe, expect, it } from 'vitest'
import { nextCronTime, parseCron } from './cron.js'

const NY = 'America/New_York'
const UTC = 'UTC'

/** Renders an instant as wall-clock in a zone, for readable assertions. */
function inZone(ts: number | undefined, timeZone = UTC): string | undefined {
  if (ts === undefined) return undefined
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

/** The next fire of `expr` after `from`, as wall-clock in `timeZone`. */
function next(expr: string, from: string, timeZone = UTC): string | undefined {
  return inZone(nextCronTime(parseCron(expr), Date.parse(from), timeZone), timeZone)
}

describe('parseCron', () => {
  it('expands the field syntaxes crontab defines', () => {
    const fields = parseCron('*/15 9-17 1,15 * *')
    expect([...fields.minute]).toEqual([0, 15, 30, 45])
    expect([...fields.hour]).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17])
    expect([...fields.dayOfMonth]).toEqual([1, 15])
    expect(fields.dayOfMonth.size).toBe(2)
  })

  it('reads month and weekday names', () => {
    expect([...parseCron('0 0 * jan,jul *').month]).toEqual([1, 7])
    expect([...parseCron('0 0 * * mon-fri').dayOfWeek]).toEqual([1, 2, 3, 4, 5])
  })

  it('accepts both 0 and 7 for Sunday', () => {
    expect([...parseCron('0 0 * * 7').dayOfWeek]).toEqual([0])
  })

  it('expands the @ shorthands', () => {
    expect(parseCron('@daily')).toEqual(parseCron('0 0 * * *'))
    expect(parseCron('@hourly')).toEqual(parseCron('0 * * * *'))
    expect(parseCron('@weekly')).toEqual(parseCron('0 0 * * 0'))
  })

  it('records which day field was restricted, since the two combine by OR', () => {
    expect(parseCron('0 0 * * *').dayOfMonthRestricted).toBe(false)
    expect(parseCron('0 0 1 * *').dayOfMonthRestricted).toBe(true)
    expect(parseCron('0 0 * * mon').dayOfWeekRestricted).toBe(true)
    // `*/2` is a restriction even though the field is written with a star.
    expect(parseCron('0 0 */2 * *').dayOfMonthRestricted).toBe(true)
  })

  it.each([
    ['0 0 * *', /needs 5 fields/],
    ['60 0 * * *', /minute must be between 0 and 59/],
    ['0 24 * * *', /hour must be between 0 and 23/],
    ['0 0 0 * *', /day-of-month must be between 1 and 31/],
    ['0 0 * 13 *', /month must be between 1 and 12/],
    ['0 0 * * 8', /day-of-week must be between 0 and 6/],
    ['5-1 0 * * *', /runs backwards/],
    ['*/0 0 * * *', /step must be a positive number/],
    ['x 0 * * *', /"x" is not a valid minute/],
    ['0 0 * * mon,,fri', /empty day-of-week/],
  ])('rejects %j, naming the field', (expr, message) => {
    expect(() => parseCron(expr)).toThrow(message)
  })
})

describe('nextCronTime', () => {
  it('finds the next matching minute, strictly after the given instant', () => {
    expect(next('*/15 * * * *', '2026-09-09T10:00:00Z')).toBe('2026-09-09 10:15')
    expect(next('*/15 * * * *', '2026-09-09T10:14:59Z')).toBe('2026-09-09 10:15')
    // Exactly on a fire time yields the following one, never the same instant.
    expect(next('0 * * * *', '2026-09-09T10:00:00Z')).toBe('2026-09-09 11:00')
  })

  it('rolls forward across hours, days, months and years', () => {
    expect(next('0 9 * * *', '2026-09-09T10:00:00Z')).toBe('2026-09-10 09:00')
    expect(next('0 0 1 * *', '2026-09-09T10:00:00Z')).toBe('2026-10-01 00:00')
    expect(next('0 0 1 1 *', '2026-09-09T10:00:00Z')).toBe('2027-01-01 00:00')
  })

  it('matches weekdays', () => {
    // 2026-09-09 is a Wednesday.
    expect(next('0 9 * * 1-5', '2026-09-11T10:00:00Z')).toBe('2026-09-14 09:00') // Fri -> Mon
    expect(next('0 9 * * mon', '2026-09-09T10:00:00Z')).toBe('2026-09-14 09:00')
  })

  it('ORs day-of-month with day-of-week when both are restricted', () => {
    // "the 1st, or any Monday" — 2026-09-14 is a Monday, 2026-10-01 the 1st.
    expect(next('0 0 1 * mon', '2026-09-09T10:00:00Z')).toBe('2026-09-14 00:00')
    // With only day-of-month restricted there is no weekday clause to OR in.
    expect(next('0 0 1 * *', '2026-09-09T10:00:00Z')).toBe('2026-10-01 00:00')
  })

  it('finds a date that occurs only rarely', () => {
    // Feb 29 next falls in 2028.
    expect(next('0 0 29 2 *', '2026-09-09T10:00:00Z')).toBe('2028-02-29 00:00')
  })

  it('gives up rather than looping on a date that never occurs', () => {
    // February 31st.
    expect(nextCronTime(parseCron('0 0 31 2 *'), Date.parse('2026-09-09T10:00:00Z'), UTC)).toBeUndefined()
  })

  describe('time zones', () => {
    it('fires on local wall-clock time, not UTC', () => {
      expect(next('0 9 * * *', '2026-09-09T20:00:00Z', NY)).toBe('2026-09-10 09:00')
      // Which is 13:00Z while New York is on EDT.
      expect(nextCronTime(parseCron('0 9 * * *'), Date.parse('2026-09-09T20:00:00Z'), NY)).toBe(
        Date.parse('2026-09-10T13:00:00Z'),
      )
    })

    it('holds the wall-clock hour across a DST change', () => {
      // US clocks spring forward on 2027-03-14; 9am stays 9am either side.
      expect(next('0 9 * * *', '2027-03-13T20:00:00Z', NY)).toBe('2027-03-14 09:00')
      expect(nextCronTime(parseCron('0 9 * * *'), Date.parse('2027-03-13T20:00:00Z'), NY)).toBe(
        Date.parse('2027-03-14T13:00:00Z'), // EDT, not the 14:00Z EST would give
      )
    })

    it('still fires a daily time the clocks jump over', () => {
      // 02:30 does not exist on 2027-03-14 in New York; the task must not be
      // silently skipped for the day.
      const fire = nextCronTime(parseCron('30 2 * * *'), Date.parse('2027-03-14T06:00:00Z'), NY)
      expect(fire).toBeDefined()
      expect(inZone(fire, NY)).toBe('2027-03-14 03:30')
    })

    it('fires a daily time twice-over hour only once', () => {
      // 01:30 happens twice on 2027-11-07 in New York when clocks fall back.
      const first = nextCronTime(parseCron('30 1 * * *'), Date.parse('2027-11-07T04:00:00Z'), NY)
      expect(inZone(first, NY)).toBe('2027-11-07 01:30')
      const second = nextCronTime(parseCron('30 1 * * *'), first!, NY)
      expect(inZone(second, NY)).toBe('2027-11-08 01:30')
    })
  })
})
