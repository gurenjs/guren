import type { ParsedCron } from './types'

/**
 * Parse a cron field value.
 */
function parseField(field: string, min: number, max: number): number[] {
  const values: Set<number> = new Set()

  // Handle comma-separated values
  const parts = field.split(',')

  for (const part of parts) {
    // Handle step values (*/5, 1-10/2)
    const stepMatch = part.match(/^(.+)\/(\d+)$/)
    let range: string
    let step = 1

    if (stepMatch) {
      range = stepMatch[1]
      step = parseInt(stepMatch[2], 10)
    } else {
      range = part
    }

    // Handle wildcard
    if (range === '*') {
      for (let i = min; i <= max; i += step) {
        values.add(i)
      }
      continue
    }

    // Handle range (1-5)
    const rangeMatch = range.match(/^(\d+)-(\d+)$/)
    if (rangeMatch) {
      const start = parseInt(rangeMatch[1], 10)
      const end = parseInt(rangeMatch[2], 10)
      for (let i = start; i <= end; i += step) {
        if (i >= min && i <= max) {
          values.add(i)
        }
      }
      continue
    }

    // Handle single value
    const value = parseInt(range, 10)
    if (!isNaN(value) && value >= min && value <= max) {
      values.add(value)
    }
  }

  return Array.from(values).sort((a, b) => a - b)
}

/**
 * Parse a cron expression.
 *
 * Cron format: minute hour dayOfMonth month dayOfWeek
 *
 * Examples:
 * - Every minute: "* * * * *"
 * - Every 5 minutes: "*​/5 * * * *" (step value)
 * - At 3:00 AM daily: "0 3 * * *"
 * - Every Monday at 9:00 AM: "0 9 * * 1"
 */
export function parseCron(expression: string): ParsedCron {
  const parts = expression.trim().split(/\s+/)

  if (parts.length !== 5) {
    throw new Error(`Invalid cron expression: ${expression}. Expected 5 fields.`)
  }

  return {
    minute: parseField(parts[0], 0, 59),
    hour: parseField(parts[1], 0, 23),
    dayOfMonth: parseField(parts[2], 1, 31),
    month: parseField(parts[3], 1, 12),
    dayOfWeek: parseField(parts[4], 0, 6), // 0 = Sunday
  }
}

/**
 * Check if a date matches a parsed cron expression.
 */
export function matchesCron(date: Date, cron: ParsedCron): boolean {
  const minute = date.getMinutes()
  const hour = date.getHours()
  const dayOfMonth = date.getDate()
  const month = date.getMonth() + 1
  const dayOfWeek = date.getDay()

  return (
    cron.minute.includes(minute) &&
    cron.hour.includes(hour) &&
    cron.dayOfMonth.includes(dayOfMonth) &&
    cron.month.includes(month) &&
    cron.dayOfWeek.includes(dayOfWeek)
  )
}

/**
 * Get the next occurrence of a cron expression.
 */
export function getNextOccurrence(
  expression: string,
  from: Date = new Date()
): Date {
  const cron = parseCron(expression)
  const next = new Date(from)

  // Start from the next minute
  next.setSeconds(0)
  next.setMilliseconds(0)
  next.setMinutes(next.getMinutes() + 1)

  // Search for the next matching time (up to 2 years)
  const maxIterations = 525600 // 1 year in minutes
  let iterations = 0

  while (iterations < maxIterations) {
    if (matchesCron(next, cron)) {
      return next
    }

    next.setMinutes(next.getMinutes() + 1)
    iterations++
  }

  throw new Error(`Could not find next occurrence for: ${expression}`)
}

/**
 * Check if a cron expression is due at the given date.
 */
export function isDue(expression: string, date: Date = new Date()): boolean {
  const cron = parseCron(expression)
  return matchesCron(date, cron)
}

/**
 * Get multiple next occurrences.
 */
export function getNextOccurrences(
  expression: string,
  count: number,
  from: Date = new Date()
): Date[] {
  const occurrences: Date[] = []
  let current = from

  for (let i = 0; i < count; i++) {
    const next = getNextOccurrence(expression, current)
    occurrences.push(next)
    current = next
  }

  return occurrences
}

/**
 * Convert a Date to a specific timezone.
 */
export function toTimezone(date: Date, timezone: string): Date {
  // Create a date string in the target timezone
  const options: Intl.DateTimeFormatOptions = {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }

  const formatter = new Intl.DateTimeFormat('en-US', options)
  const parts = formatter.formatToParts(date)

  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '0'

  const year = parseInt(get('year'), 10)
  const month = parseInt(get('month'), 10) - 1
  const day = parseInt(get('day'), 10)
  const hour = parseInt(get('hour'), 10)
  const minute = parseInt(get('minute'), 10)
  const second = parseInt(get('second'), 10)

  return new Date(year, month, day, hour, minute, second)
}

/**
 * Check if a cron expression is due in a specific timezone.
 */
export function isDueInTimezone(
  expression: string,
  timezone: string,
  date: Date = new Date()
): boolean {
  const localDate = toTimezone(date, timezone)
  return isDue(expression, localDate)
}
