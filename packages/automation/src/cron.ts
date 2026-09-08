import { fromWallClock, wallClockAt, type WallClock } from './when.js'

/**
 * A five-field cron expression, parsed into the set of values each field
 * permits.
 *
 * Whether a field was restricted is kept alongside the set, because
 * day-of-month and day-of-week combine by OR rather than AND when both are
 * given — `0 0 1 * mon` is "the 1st, and every Monday", not "Mondays that fall
 * on the 1st". That rule is only expressible if "unrestricted" is
 * distinguishable from "happens to allow everything".
 */
export interface CronFields {
  minute: Set<number>
  hour: Set<number>
  dayOfMonth: Set<number>
  month: Set<number>
  dayOfWeek: Set<number>
  dayOfMonthRestricted: boolean
  dayOfWeekRestricted: boolean
}

const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

/** The shorthands people expect from crontab. */
const ALIASES: Record<string, string> = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
}

interface FieldSpec {
  name: string
  min: number
  max: number
  names?: string[]
}

const FIELDS: FieldSpec[] = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day-of-month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12, names: MONTH_NAMES },
  { name: 'day-of-week', min: 0, max: 6, names: DAY_NAMES },
]

/** How far ahead `nextCronTime` will look before giving up. */
const SEARCH_LIMIT_DAYS = 4 * 366

function parseValue(token: string, field: FieldSpec): number {
  const named = field.names?.indexOf(token)
  if (named !== undefined && named >= 0) return named + field.min

  if (!/^\d+$/.test(token)) {
    throw new Error(`"${token}" is not a valid ${field.name}`)
  }
  const value = Number(token)
  // Cron writes Sunday as either 0 or 7.
  const normalized = field.name === 'day-of-week' && value === 7 ? 0 : value
  if (normalized < field.min || normalized > field.max) {
    throw new Error(`${field.name} must be between ${field.min} and ${field.max}, got ${token}`)
  }
  return normalized
}

/** Expands one field — `*`, `5`, `1-5`, `*&#47;15`, `1-5&#47;2`, `mon,wed,fri`. */
function parseField(raw: string, field: FieldSpec): { values: Set<number>; restricted: boolean } {
  const values = new Set<number>()
  let restricted = false

  for (const part of raw.toLowerCase().split(',')) {
    if (part === '') throw new Error(`empty ${field.name} in cron expression`)

    const [range, stepText] = part.split('/')
    if (part.split('/').length > 2) throw new Error(`"${part}" has more than one step in ${field.name}`)

    const step = stepText === undefined ? 1 : Number(stepText)
    if (stepText !== undefined && (!/^\d+$/.test(stepText) || step < 1)) {
      throw new Error(`step must be a positive number in ${field.name}, got "${stepText}"`)
    }

    let from: number
    let to: number
    if (range === '*') {
      from = field.min
      to = field.max
      if (step > 1) restricted = true
    } else if (range.includes('-')) {
      const [lo, hi] = range.split('-')
      from = parseValue(lo, field)
      to = parseValue(hi, field)
      if (to < from) throw new Error(`${field.name} range "${range}" runs backwards`)
      restricted = true
    } else {
      from = parseValue(range, field)
      to = stepText === undefined ? from : field.max
      restricted = true
    }

    for (let value = from; value <= to; value += step) values.add(value)
  }

  if (values.size === 0) throw new Error(`${field.name} matches nothing`)
  return { values, restricted }
}

/**
 * Parses a five-field cron expression, or one of the `@daily` shorthands.
 *
 * @throws with the offending field named, since a silently-wrong schedule is
 * far worse than a rejected one.
 */
export function parseCron(expression: string): CronFields {
  const text = expression.trim().toLowerCase()
  const expanded = ALIASES[text] ?? text
  const parts = expanded.split(/\s+/)

  if (parts.length !== 5) {
    throw new Error(
      `a cron expression needs 5 fields (minute hour day-of-month month day-of-week), got ${parts.length} in "${expression}"`,
    )
  }

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts.map((part, index) => parseField(part, FIELDS[index]))
  return {
    minute: minute.values,
    hour: hour.values,
    dayOfMonth: dayOfMonth.values,
    month: month.values,
    dayOfWeek: dayOfWeek.values,
    dayOfMonthRestricted: dayOfMonth.restricted,
    dayOfWeekRestricted: dayOfWeek.restricted,
  }
}

/** Cron's OR rule: with both day fields restricted, either one matching is enough. */
function dayMatches(fields: CronFields, wall: WallClock): boolean {
  const weekday = new Date(Date.UTC(wall.year, wall.month - 1, wall.day)).getUTCDay()
  const byDate = fields.dayOfMonth.has(wall.day)
  const byWeekday = fields.dayOfWeek.has(weekday)

  if (fields.dayOfMonthRestricted && fields.dayOfWeekRestricted) return byDate || byWeekday
  if (fields.dayOfMonthRestricted) return byDate
  if (fields.dayOfWeekRestricted) return byWeekday
  return true
}

/** Moves a wall clock on by whole days, letting `Date` roll months and years. */
function addDays(wall: WallClock, days: number): WallClock {
  const shifted = new Date(Date.UTC(wall.year, wall.month - 1, wall.day + days))
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: wall.hour,
    minute: wall.minute,
    second: wall.second,
  }
}

/**
 * The first instant strictly after `from` that matches the expression, read as
 * wall-clock time in `timeZone`.
 *
 * The search steps by the largest unit that can be ruled out — a wrong month
 * skips to the 1st of the next one rather than trying its 44,000 minutes — so
 * a rare schedule like `0 0 29 2 *` costs a few thousand comparisons, not
 * millions. Returns `undefined` for an expression that matches no real date
 * within four years, which is how `31 2 *` (February 31st) is reported.
 *
 * Fire times are wall-clock: `0 9 * * *` is 9am local every day, DST or not.
 * A time the clocks jump over resolves to the first real instant after it, so
 * a daily 02:30 still fires on a spring-forward morning.
 */
export function nextCronTime(fields: CronFields, from: number, timeZone: string): number | undefined {
  const start = wallClockAt(from, timeZone)
  // Cron has minute resolution; begin at the next whole minute after `from`.
  let wall: WallClock = {
    year: start.year,
    month: start.month,
    day: start.day,
    hour: start.hour,
    minute: start.minute,
    second: 0,
  }
  let cursor = fromWallClock(wall, timeZone)
  if (cursor <= from) {
    wall = { ...wall, minute: wall.minute + 1 }
    wall = normalize(wall)
  }

  for (let day = 0; day <= SEARCH_LIMIT_DAYS;) {
    if (!fields.month.has(wall.month)) {
      const next = wall.month === 12 ? { year: wall.year + 1, month: 1 } : { year: wall.year, month: wall.month + 1 }
      wall = { ...next, day: 1, hour: 0, minute: 0, second: 0 }
      day++
      continue
    }
    if (!dayMatches(fields, wall)) {
      wall = { ...addDays(wall, 1), hour: 0, minute: 0, second: 0 }
      day++
      continue
    }
    if (!fields.hour.has(wall.hour)) {
      wall = normalize({ ...wall, hour: wall.hour + 1, minute: 0 })
      continue
    }
    if (!fields.minute.has(wall.minute)) {
      wall = normalize({ ...wall, minute: wall.minute + 1 })
      continue
    }

    cursor = fromWallClock(wall, timeZone)
    // A wall clock DST skipped resolves forward, which can land before the
    // cursor we started from; step past it rather than firing in the past.
    if (cursor > from) return cursor
    wall = normalize({ ...wall, minute: wall.minute + 1 })
  }

  return undefined
}

/** Carries minute/hour overflow into the following hour, day, month and year. */
function normalize(wall: WallClock): WallClock {
  const shifted = new Date(Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second))
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
  }
}
