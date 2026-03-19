import type { LogChannel, LogEntry, ConsoleChannelConfig, LogLevel } from '../types'
import { LOG_LEVEL_PRIORITY } from '../types'

/**
 * ANSI color codes for log levels.
 */
const LEVEL_COLORS: Record<LogLevel, string> = {
  emergency: '\x1b[41m\x1b[37m', // White on red background
  alert: '\x1b[41m\x1b[37m', // White on red background
  critical: '\x1b[31m', // Red
  error: '\x1b[31m', // Red
  warning: '\x1b[33m', // Yellow
  notice: '\x1b[36m', // Cyan
  info: '\x1b[32m', // Green
  debug: '\x1b[90m', // Gray
}

const RESET = '\x1b[0m'

/**
 * Console log channel.
 */
export class ConsoleChannel implements LogChannel {
  private readonly config: ConsoleChannelConfig
  private readonly minLevel: number

  constructor(config: ConsoleChannelConfig) {
    this.config = {
      colors: true,
      timestamps: true,
      format: 'text',
      ...config,
    }
    this.minLevel = LOG_LEVEL_PRIORITY[this.config.level ?? 'debug']
  }

  log(entry: LogEntry): void {
    const entryLevel = LOG_LEVEL_PRIORITY[entry.level]
    if (entryLevel > this.minLevel) {
      return
    }

    const output = this.format(entry)

    // Use appropriate console method
    if (entryLevel <= LOG_LEVEL_PRIORITY.error) {
      console.error(output)
    } else if (entryLevel <= LOG_LEVEL_PRIORITY.warning) {
      console.warn(output)
    } else if (entryLevel <= LOG_LEVEL_PRIORITY.info) {
      console.info(output)
    } else {
      console.log(output)
    }
  }

  private format(entry: LogEntry): string {
    if (this.config.format === 'json') {
      return JSON.stringify({
        timestamp: entry.timestamp.toISOString(),
        level: entry.level,
        message: entry.message,
        ...entry.context,
      })
    }

    const parts: string[] = []

    // Timestamp
    if (this.config.timestamps) {
      const time = entry.timestamp.toISOString()
      parts.push(this.config.colors ? `\x1b[90m[${time}]\x1b[0m` : `[${time}]`)
    }

    // Level
    const levelStr = entry.level.toUpperCase().padEnd(9)
    if (this.config.colors) {
      parts.push(`${LEVEL_COLORS[entry.level]}${levelStr}${RESET}`)
    } else {
      parts.push(levelStr)
    }

    // Message
    parts.push(entry.message)

    // Context
    if (Object.keys(entry.context).length > 0) {
      const contextStr = JSON.stringify(entry.context)
      if (this.config.colors) {
        parts.push(`\x1b[90m${contextStr}${RESET}`)
      } else {
        parts.push(contextStr)
      }
    }

    return parts.join(' ')
  }
}
