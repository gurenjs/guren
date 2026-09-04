import type { LogChannel, LogLevel, LogContext, LogEntry } from './types'

export interface LoggerOptions {
  /** Keys to redact. Matching is case-insensitive and recursive. */
  filterKeys?: string[]
  /** Replacement string for filtered values. Default: '[FILTERED]' */
  replacement?: string
}

const DEFAULT_FILTER_KEYS = [
  'password',
  'password_confirmation',
  'token',
  'secret',
  'credit_card',
  'creditCard',
  'card_number',
  'cardNumber',
  'cvv',
  'ssn',
  'authorization',
]

/** Recursively replace values of sensitive keys in a log context object. */
export function filterSensitiveData(
  data: Record<string, unknown>,
  filterKeys: string[],
  replacement = '[FILTERED]',
): Record<string, unknown> {
  if (filterKeys.length === 0) return data

  const keySet = new Set(filterKeys.map((k) => k.toLowerCase()))
  return filterObject(data, keySet, replacement)
}

function filterObject(
  obj: Record<string, unknown>,
  keySet: Set<string>,
  replacement: string,
): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(obj)) {
    if (keySet.has(key.toLowerCase())) {
      result[key] = replacement
    } else if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      result[key] = filterObject(value as Record<string, unknown>, keySet, replacement)
    } else if (Array.isArray(value)) {
      result[key] = value.map((item) =>
        item !== null && typeof item === 'object' && !Array.isArray(item)
          ? filterObject(item as Record<string, unknown>, keySet, replacement)
          : item,
      )
    } else {
      result[key] = value
    }
  }
  return result
}

// Logging errors are reported, never thrown, so a broken channel cannot cascade
// into the request that logged. Async channels reject instead of throwing, so
// the same reporter is attached to their promise.
const reportLoggingError = (error: unknown): void => {
  console.error('Logging error:', error)
}

/** Logger instance for writing log entries. */
export class Logger {
  private readonly channels: LogChannel[]
  private readonly baseContext: LogContext
  private readonly filterKeys: string[]
  private readonly replacement: string

  constructor(channels: LogChannel[], context: LogContext = {}, options: LoggerOptions = {}) {
    this.channels = channels
    this.baseContext = context
    this.filterKeys = options.filterKeys ?? DEFAULT_FILTER_KEYS
    this.replacement = options.replacement ?? '[FILTERED]'
  }

  emergency(message: string, context: LogContext = {}): void {
    this.log('emergency', message, context)
  }

  alert(message: string, context: LogContext = {}): void {
    this.log('alert', message, context)
  }

  critical(message: string, context: LogContext = {}): void {
    this.log('critical', message, context)
  }

  error(message: string, context: LogContext = {}): void {
    this.log('error', message, context)
  }

  warning(message: string, context: LogContext = {}): void {
    this.log('warning', message, context)
  }

  warn(message: string, context: LogContext = {}): void {
    this.warning(message, context)
  }

  notice(message: string, context: LogContext = {}): void {
    this.log('notice', message, context)
  }

  info(message: string, context: LogContext = {}): void {
    this.log('info', message, context)
  }

  debug(message: string, context: LogContext = {}): void {
    this.log('debug', message, context)
  }

  log(level: LogLevel, message: string, context: LogContext = {}): void {
    const merged = { ...this.baseContext, ...context }
    const filtered = this.filterKeys.length > 0
      ? filterSensitiveData(merged, this.filterKeys, this.replacement)
      : merged

    const entry: LogEntry = {
      level,
      message,
      context: filtered,
      timestamp: new Date(),
    }

    for (const channel of this.channels) {
      try {
        const pending = channel.log(entry)
        if (pending instanceof Promise) {
          pending.catch(reportLoggingError)
        }
      } catch (error) {
        reportLoggingError(error)
      }
    }
  }

  withContext(context: LogContext): Logger {
    return new Logger(this.channels, { ...this.baseContext, ...context }, {
      filterKeys: this.filterKeys,
      replacement: this.replacement,
    })
  }

  child(context: LogContext): Logger {
    return this.withContext(context)
  }

  async close(): Promise<void> {
    for (const channel of this.channels) {
      if (channel.close) {
        await channel.close()
      }
    }
  }
}
