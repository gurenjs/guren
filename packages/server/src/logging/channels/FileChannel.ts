import * as fs from 'node:fs'
import * as path from 'node:path'
import type { LogChannel, LogEntry, FileChannelConfig } from '../types'
import { LOG_LEVEL_PRIORITY } from '../types'

/**
 * File log channel.
 */
export class FileChannel implements LogChannel {
  private readonly config: FileChannelConfig
  private readonly minLevel: number
  private initialized = false

  constructor(config: FileChannelConfig) {
    this.config = {
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

    const line = this.format(entry) + '\n'
    this.write(line)
  }

  private write(data: string): void {
    if (!this.initialized) {
      this.ensureDirectory()
      this.initialized = true
    }
    fs.appendFileSync(this.config.path, data)
  }

  private ensureDirectory(): void {
    const dir = path.dirname(this.config.path)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
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

    const timestamp = entry.timestamp.toISOString()
    const level = entry.level.toUpperCase().padEnd(9)
    const context =
      Object.keys(entry.context).length > 0 ? ' ' + JSON.stringify(entry.context) : ''

    return `[${timestamp}] ${level} ${entry.message}${context}`
  }

  close(): void {
    // No-op for sync writes
  }
}
