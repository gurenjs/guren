import * as fs from 'node:fs'
import * as path from 'node:path'
import type { LogChannel, LogEntry, DailyFileChannelConfig } from '../types'
import { LOG_LEVEL_PRIORITY } from '../types'
import { dailyFileDateStamp, dailyFilePath, matchDailyFileDate } from '../daily-file-path'

/**
 * Daily rotating file log channel.
 */
export class DailyFileChannel implements LogChannel {
  private readonly config: DailyFileChannelConfig
  private readonly minLevel: number
  private currentDate: string | null = null
  private currentFilePath: string | null = null

  constructor(config: DailyFileChannelConfig) {
    this.config = {
      days: 14,
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

    const dateStr = dailyFileDateStamp(entry.timestamp)

    // Rotate if date changed
    if (this.currentDate !== dateStr) {
      this.rotate(entry.timestamp, dateStr)
    }

    const line = this.format(entry) + '\n'
    this.write(line)
  }

  private write(data: string): void {
    if (this.currentFilePath) {
      fs.appendFileSync(this.currentFilePath, data)
    }
  }

  private rotate(date: Date, dateStr: string): void {
    this.currentDate = dateStr
    this.currentFilePath = dailyFilePath(this.config.path, date)
    this.ensureDirectory(this.currentFilePath)

    // Clean up old files
    this.cleanup()
  }

  private ensureDirectory(filePath: string): void {
    const dir = path.dirname(filePath)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
  }

  private cleanup(): void {
    const dir = path.dirname(this.config.path)

    if (!fs.existsSync(dir)) {
      return
    }

    const files = fs.readdirSync(dir)
    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - (this.config.days ?? 14))

    for (const file of files) {
      const stamp = matchDailyFileDate(this.config.path, file)
      if (stamp !== null && new Date(stamp) < cutoff) {
        fs.unlinkSync(path.join(dir, file))
      }
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
