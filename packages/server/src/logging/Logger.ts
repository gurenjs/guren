import type { LogChannel, LogLevel, LogContext, LogEntry } from './types'

/**
 * Logger instance for writing log entries.
 */
export class Logger {
  private readonly channels: LogChannel[]
  private readonly baseContext: LogContext

  constructor(channels: LogChannel[], context: LogContext = {}) {
    this.channels = channels
    this.baseContext = context
  }

  /**
   * Log at emergency level (system is unusable).
   */
  emergency(message: string, context: LogContext = {}): void {
    this.log('emergency', message, context)
  }

  /**
   * Log at alert level (action must be taken immediately).
   */
  alert(message: string, context: LogContext = {}): void {
    this.log('alert', message, context)
  }

  /**
   * Log at critical level (critical conditions).
   */
  critical(message: string, context: LogContext = {}): void {
    this.log('critical', message, context)
  }

  /**
   * Log at error level (error conditions).
   */
  error(message: string, context: LogContext = {}): void {
    this.log('error', message, context)
  }

  /**
   * Log at warning level (warning conditions).
   */
  warning(message: string, context: LogContext = {}): void {
    this.log('warning', message, context)
  }

  /**
   * Alias for warning().
   */
  warn(message: string, context: LogContext = {}): void {
    this.warning(message, context)
  }

  /**
   * Log at notice level (normal but significant conditions).
   */
  notice(message: string, context: LogContext = {}): void {
    this.log('notice', message, context)
  }

  /**
   * Log at info level (informational messages).
   */
  info(message: string, context: LogContext = {}): void {
    this.log('info', message, context)
  }

  /**
   * Log at debug level (debug-level messages).
   */
  debug(message: string, context: LogContext = {}): void {
    this.log('debug', message, context)
  }

  /**
   * Log a message at the specified level.
   */
  log(level: LogLevel, message: string, context: LogContext = {}): void {
    const entry: LogEntry = {
      level,
      message,
      context: { ...this.baseContext, ...context },
      timestamp: new Date(),
    }

    for (const channel of this.channels) {
      try {
        channel.log(entry)
      } catch (error) {
        // Silently ignore logging errors to prevent cascading failures
        console.error('Logging error:', error)
      }
    }
  }

  /**
   * Create a new logger with additional context.
   */
  withContext(context: LogContext): Logger {
    return new Logger(this.channels, { ...this.baseContext, ...context })
  }

  /**
   * Create a child logger with additional context (alias for withContext).
   */
  child(context: LogContext): Logger {
    return this.withContext(context)
  }

  /**
   * Close all channels.
   */
  async close(): Promise<void> {
    for (const channel of this.channels) {
      if (channel.close) {
        await channel.close()
      }
    }
  }
}
