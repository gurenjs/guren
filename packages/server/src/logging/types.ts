/** Log level types (RFC 5424 severity levels). */
export type LogLevel =
  | 'emergency'
  | 'alert'
  | 'critical'
  | 'error'
  | 'warning'
  | 'notice'
  | 'info'
  | 'debug'

/** Log level priority (lower = more severe). */
export const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  emergency: 0,
  alert: 1,
  critical: 2,
  error: 3,
  warning: 4,
  notice: 5,
  info: 6,
  debug: 7,
}

/** Log context (additional data attached to log entries). */
export type LogContext = Record<string, unknown>

/** Log entry structure. */
export interface LogEntry {
  level: LogLevel
  message: string
  context: LogContext
  timestamp: Date
}

/** Log channel interface. */
export interface LogChannel {
  log(entry: LogEntry): void | Promise<void>

  close?(): void | Promise<void>
}

/** Log channel factory. */
export type LogChannelFactory = (config: LogChannelConfig) => LogChannel

/** Base channel configuration. */
export interface LogChannelConfig {
  driver: string
  level?: LogLevel
  [key: string]: unknown
}

/** Console channel configuration. */
export interface ConsoleChannelConfig extends LogChannelConfig {
  driver: 'console'
  colors?: boolean
  timestamps?: boolean
  format?: 'text' | 'json'
}

/** File channel configuration. */
export interface FileChannelConfig extends LogChannelConfig {
  driver: 'file'
  path: string
  format?: 'text' | 'json'
}

/** Daily file channel configuration. */
export interface DailyFileChannelConfig extends LogChannelConfig {
  driver: 'daily'
  path: string
  days?: number
  format?: 'text' | 'json'
}

/** Stack channel configuration. */
export interface StackChannelConfig extends LogChannelConfig {
  driver: 'stack'
  channels: string[]
}

/** Log manager configuration. */
export interface LogConfig {
  default: string
  channels: Record<string, LogChannelConfig>
  /** Keys whose values are replaced with '[FILTERED]' in log context. */
  filterKeys?: string[]
  /** Replacement string for filtered values. Default: '[FILTERED]' */
  filterReplacement?: string
}

/** Log formatter. */
export interface LogFormatter {
  format(entry: LogEntry): string
}
