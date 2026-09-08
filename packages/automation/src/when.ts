/**
 * Turning "tomorrow at 9am" into an instant.
 *
 * Scheduling is only as useful as the times people can express, and every
 * form here resolves against a real IANA time zone rather than a fixed
 * offset — "9am daily" has to stay 9am across a DST boundary, which a stored
 * offset cannot do.
 */

export interface ParseWhenOptions {
  /** The moment to resolve relative expressions against (default: now). */
  now?: number
  /**
   * IANA zone the wall-clock forms are read in (default: the host's zone).
   * Explicit offsets inside an ISO timestamp always win over this.
   */
  timeZone?: string
}

/** Wall-clock fields, with no zone attached. */
interface WallClock {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

const MS = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
} as const

/** Every spelling of a duration unit we accept, mapped to its base unit. */
const UNIT_ALIASES: Record<string, keyof typeof MS> = {
  ms: 'ms',
  milli: 'ms',
  millis: 'ms',
  millisecond: 'ms',
  milliseconds: 'ms',
  s: 's',
  sec: 's',
  secs: 's',
  second: 's',
  seconds: 's',
  m: 'm',
  min: 'm',
  mins: 'm',
  minute: 'm',
  minutes: 'm',
  h: 'h',
  hr: 'h',
  hrs: 'h',
  hour: 'h',
  hours: 'h',
  d: 'd',
  day: 'd',
  days: 'd',
  w: 'w',
  wk: 'w',
  wks: 'w',
  week: 'w',
  weeks: 'w',
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']

const ACCEPTED_FORMS = [
  'an ISO timestamp ("2026-09-10T09:00:00Z", "2026-09-10 09:00")',
  'a duration ("in 30 minutes", "+2h30m", "45m")',
  'a clock time ("at 9am", "21:30", "noon")',
  'a day and time ("tomorrow at 9am", "friday 17:00", "next monday")',
].join(', ')

/**
 * The zone's UTC offset in milliseconds at a given instant.
 *
 * There is no API that answers this directly, so the instant is formatted in
 * the target zone and the resulting wall-clock read back as if it were UTC —
 * the gap between the two is the offset.
 */
function offsetAt(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(instant))

  const field = (type: string) => Number(parts.find((p) => p.type === type)?.value)
  const asUtc = Date.UTC(
    field('year'),
    field('month') - 1,
    field('day'),
    field('hour'),
    field('minute'),
    field('second'),
  )
  // Formatting drops sub-second precision; ignore it rather than letting it
  // leak a spurious offset of a few hundred milliseconds.
  return asUtc - Math.floor(instant / 1000) * 1000
}

/** The wall-clock reading in `timeZone` at a given instant. */
function wallClockAt(instant: number, timeZone: string): WallClock & { weekday: number } {
  const local = new Date(instant + offsetAt(instant, timeZone))
  return {
    year: local.getUTCFullYear(),
    month: local.getUTCMonth() + 1,
    day: local.getUTCDate(),
    hour: local.getUTCHours(),
    minute: local.getUTCMinutes(),
    second: local.getUTCSeconds(),
    weekday: local.getUTCDay(),
  }
}

/**
 * The instant at which `timeZone` reads the given wall clock.
 *
 * The offset depends on the answer, so it is applied and then re-checked: a
 * time on the far side of a DST change resolves with the wrong offset on the
 * first pass, and the second pass corrects it. A wall clock that DST skips
 * entirely has no exact instant — it resolves to the moment the clocks jumped
 * past it, which is the first real time at or after what was asked for.
 */
function fromWallClock(wall: WallClock, timeZone: string): number {
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second)
  const first = asUtc - offsetAt(asUtc, timeZone)
  const second = asUtc - offsetAt(first, timeZone)

  // When the correction lands on the wall clock that was asked for, take it.
  // When it cannot — the clocks jumped over that reading, so no instant has
  // it — the uncorrected pass is the requested time shifted forward by the
  // gap, which is the first real time after the one that does not exist.
  const reached = wallClockAt(second, timeZone)
  const matches =
    reached.year === wall.year &&
    reached.month === wall.month &&
    reached.day === wall.day &&
    reached.hour === wall.hour &&
    reached.minute === wall.minute
  return matches ? second : first
}

/** Sums a duration like "2h30m" or "1 day 6 hours"; undefined if it is not one. */
function parseDuration(text: string): number | undefined {
  // Match against the whitespace-free form so "30 minutes" and "30m" are one
  // case, and so leftover words are detectable by length alone.
  const compact = text.replace(/\s+/g, '')
  let total = 0
  let matched = 0
  let consumed = 0
  for (const [whole, amount, unit] of compact.matchAll(/(\d+(?:\.\d+)?)([a-z]+)/g)) {
    const base = UNIT_ALIASES[unit]
    if (!base) return undefined
    total += Number(amount) * MS[base]
    matched++
    consumed += whole.length
  }
  if (matched === 0) return undefined
  // Rejects "9am" (which matches as 9 "am") and anything with leftover words.
  if (consumed !== compact.length) return undefined
  return total
}

/** Reads "9am", "9:30pm", "17:00", "noon", "midnight". */
function parseClockTime(text: string): { hour: number; minute: number } | undefined {
  if (text === 'noon' || text === 'midday') return { hour: 12, minute: 0 }
  if (text === 'midnight') return { hour: 0, minute: 0 }

  const match = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(text)
  if (!match) return undefined

  const [, rawHour, rawMinute, meridiem] = match
  let hour = Number(rawHour)
  const minute = rawMinute === undefined ? 0 : Number(rawMinute)
  if (minute > 59) return undefined

  if (meridiem) {
    if (hour < 1 || hour > 12) return undefined
    if (meridiem === 'pm' && hour !== 12) hour += 12
    if (meridiem === 'am' && hour === 12) hour = 0
  } else if (hour > 23) {
    return undefined
  } else if (rawMinute === undefined) {
    // A bare number with no minutes and no am/pm is a duration ("30"), not a
    // time — refuse it rather than guessing which the user meant.
    return undefined
  }

  return { hour, minute }
}

/**
 * Resolves a human time expression to an epoch-millisecond instant.
 *
 * Wall-clock forms always land in the future: a bare time already past today
 * rolls to tomorrow, and a weekday resolves to its next occurrence. An
 * explicit ISO timestamp is taken at face value, past or not — if someone
 * names a date, they mean that date.
 *
 * @throws if the expression is not one of the accepted forms.
 */
export function parseWhen(input: string, options: ParseWhenOptions = {}): number {
  const now = options.now ?? Date.now()
  const timeZone = options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  const text = input.trim().toLowerCase().replace(/\s+/g, ' ')
  if (!text) throw new Error('a time is required')

  // ISO first: it is unambiguous and the only form that may point at the past.
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return parseIso(text, timeZone)

  const relative = text.startsWith('in ') ? text.slice(3) : text.startsWith('+') ? text.slice(1) : text
  const duration = parseDuration(relative)
  if (duration !== undefined) return now + duration

  return parseWallClock(text, now, timeZone)
}

/** ISO 8601, with a bare local datetime read in `timeZone`. */
function parseIso(text: string, timeZone: string): number {
  const normalized = text.replace(' ', 't')
  const zoned = /(z|[+-]\d{2}:?\d{2})$/i.test(normalized)
  if (zoned) {
    const parsed = Date.parse(normalized)
    if (Number.isNaN(parsed)) throw new Error(`could not read "${text}" as a timestamp`)
    return parsed
  }

  const match = /^(\d{4})-(\d{2})-(\d{2})(?:t(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(normalized)
  if (!match) throw new Error(`could not read "${text}" as a timestamp`)
  const [, year, month, day, hour, minute, second] = match
  return fromWallClock(
    {
      year: Number(year),
      month: Number(month),
      day: Number(day),
      hour: Number(hour ?? 0),
      minute: Number(minute ?? 0),
      second: Number(second ?? 0),
    },
    timeZone,
  )
}

/** "tomorrow at 9am", "friday 17:00", "next monday", "at 21:30", "noon". */
function parseWallClock(text: string, now: number, timeZone: string): number {
  let rest = text
  let dayOffset: number | undefined
  let weekday: number | undefined

  if (rest.startsWith('today')) {
    dayOffset = 0
    rest = rest.slice('today'.length).trim()
  } else if (rest.startsWith('tomorrow')) {
    dayOffset = 1
    rest = rest.slice('tomorrow'.length).trim()
  } else {
    const next = rest.startsWith('next ') ? rest.slice(5).trim() : rest
    const named = WEEKDAYS.findIndex((day) => next === day || next.startsWith(`${day} `))
    if (named >= 0) {
      weekday = named
      rest = next.slice(WEEKDAYS[named].length).trim()
    }
  }

  if (rest.startsWith('at ')) rest = rest.slice(3).trim()

  // A day with no time means the start of that day.
  const clock =
    rest === '' && (dayOffset !== undefined || weekday !== undefined) ? { hour: 0, minute: 0 } : parseClockTime(rest)
  if (!clock) throw new Error(`could not read "${text}" as a time — expected ${ACCEPTED_FORMS}`)

  const today = wallClockAt(now, timeZone)
  const base: WallClock = {
    year: today.year,
    month: today.month,
    day: today.day,
    hour: clock.hour,
    minute: clock.minute,
    second: 0,
  }

  if (weekday !== undefined) {
    // The next occurrence of that weekday, never today: "friday" said on a
    // Friday means the one coming, which is what people mean by it.
    const ahead = (weekday - today.weekday + 7) % 7 || 7
    return fromWallClock(addDays(base, ahead), timeZone)
  }

  const candidate = fromWallClock(addDays(base, dayOffset ?? 0), timeZone)
  // A bare time that has already passed today means tomorrow. An explicit
  // "today at 8am" that has passed is an error the caller should see, not a
  // silent slide into tomorrow.
  if (dayOffset === undefined && candidate <= now) return fromWallClock(addDays(base, 1), timeZone)
  return candidate
}

/** Adds whole days to a wall clock, letting `Date` normalize month ends. */
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
