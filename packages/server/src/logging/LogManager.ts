import type { LogConfig, LogChannel, LogChannelFactory } from './types'
import { Logger, type LoggerOptions } from './Logger'
import { ConsoleChannel } from './channels/ConsoleChannel'
import { FileChannel } from './channels/FileChannel'
import { DailyFileChannel } from './channels/DailyFileChannel'

/**
 * Log manager for managing multiple logging channels.
 *
 * @example
 * ```ts
 * const log = new LogManager({
 *   default: 'stack',
 *   channels: {
 *     console: { driver: 'console', level: 'debug' },
 *     file: { driver: 'daily', path: './storage/logs/app.log', days: 14 },
 *     stack: { driver: 'stack', channels: ['console', 'file'] },
 *   }
 * })
 *
 * log.info('User logged in', { userId: user.id })
 * log.error('Payment failed', { orderId, error: error.message })
 *
 * const requestLog = log.withContext({ requestId: ctx.requestId })
 * requestLog.info('Processing request')
 * ```
 */
export class LogManager {
  private readonly config: LogConfig
  private readonly channelFactories: Map<string, LogChannelFactory> = new Map()
  private readonly channelInstances: Map<string, LogChannel> = new Map()
  private readonly loggers: Map<string, Logger> = new Map()
  private readonly loggerOptions: LoggerOptions

  constructor(config: LogConfig) {
    this.config = config
    this.loggerOptions = {
      filterKeys: config.filterKeys,
      replacement: config.filterReplacement,
    }
    this.registerDefaultDrivers()
  }

  private registerDefaultDrivers(): void {
    this.registerDriver('console', (config) => {
      return new ConsoleChannel(config as any)
    })

    this.registerDriver('file', (config) => {
      return new FileChannel(config as any)
    })

    this.registerDriver('daily', (config) => {
      return new DailyFileChannel(config as any)
    })

    this.registerDriver('stack', (config) => {
      // Stack is a special driver that combines multiple channels
      return this.createStackChannel(config as any)
    })
  }

  private createStackChannel(config: { channels: string[] }): LogChannel {
    const channels = config.channels.map((name) => this.resolveChannel(name))
    return {
      log: (entry) => {
        const pending = channels
          .map((channel) => channel.log(entry))
          .filter((result): result is Promise<void> => result instanceof Promise)
        return pending.length > 0 ? Promise.all(pending).then(() => undefined) : undefined
      },
      close: async () => {
        for (const channel of channels) {
          if (channel.close) {
            await channel.close()
          }
        }
      },
    }
  }

  /**
   * Register a custom channel driver.
   */
  registerDriver(name: string, factory: LogChannelFactory): void {
    this.channelFactories.set(name, factory)
  }

  /**
   * Get a logger for a specific channel.
   */
  channel(name?: string): Logger {
    const channelName = name ?? this.config.default

    if (!this.loggers.has(channelName)) {
      const channel = this.resolveChannel(channelName)
      this.loggers.set(channelName, new Logger([channel], {}, this.loggerOptions))
    }

    return this.loggers.get(channelName)!
  }

  /**
   * Get a logger that writes to multiple channels.
   */
  stack(channelNames: string[]): Logger {
    const key = `stack:${channelNames.join(',')}`

    if (!this.loggers.has(key)) {
      const channels = channelNames.map((name) => this.resolveChannel(name))
      this.loggers.set(key, new Logger(channels, {}, this.loggerOptions))
    }

    return this.loggers.get(key)!
  }

  private resolveChannel(name: string): LogChannel {
    if (this.channelInstances.has(name)) {
      return this.channelInstances.get(name)!
    }

    const config = this.config.channels[name]
    if (!config) {
      throw new Error(`Log channel [${name}] is not defined`)
    }

    const factory = this.channelFactories.get(config.driver)
    if (!factory) {
      throw new Error(`Log driver [${config.driver}] is not supported`)
    }

    const channel = factory(config)
    this.channelInstances.set(name, channel)
    return channel
  }

  /**
   * Create a logger with additional context using the default channel.
   */
  withContext(context: Record<string, unknown>): Logger {
    return this.channel().withContext(context)
  }

  // Convenience methods that delegate to default channel

  emergency(message: string, context?: Record<string, unknown>): void {
    this.channel().emergency(message, context)
  }

  alert(message: string, context?: Record<string, unknown>): void {
    this.channel().alert(message, context)
  }

  critical(message: string, context?: Record<string, unknown>): void {
    this.channel().critical(message, context)
  }

  error(message: string, context?: Record<string, unknown>): void {
    this.channel().error(message, context)
  }

  warning(message: string, context?: Record<string, unknown>): void {
    this.channel().warning(message, context)
  }

  warn(message: string, context?: Record<string, unknown>): void {
    this.channel().warn(message, context)
  }

  notice(message: string, context?: Record<string, unknown>): void {
    this.channel().notice(message, context)
  }

  info(message: string, context?: Record<string, unknown>): void {
    this.channel().info(message, context)
  }

  debug(message: string, context?: Record<string, unknown>): void {
    this.channel().debug(message, context)
  }

  /**
   * Close all channel instances.
   */
  async close(): Promise<void> {
    for (const channel of this.channelInstances.values()) {
      if (channel.close) {
        await channel.close()
      }
    }
    this.channelInstances.clear()
    this.loggers.clear()
  }

  /**
   * Get the default channel name.
   */
  getDefaultChannel(): string {
    return this.config.default
  }

  /**
   * Get available channel names.
   */
  getChannelNames(): string[] {
    return Object.keys(this.config.channels)
  }
}

/**
 * Create a log manager instance.
 */
export function createLogManager(config: LogConfig): LogManager {
  return new LogManager(config)
}

// Global log manager instance
let globalLogManager: LogManager | null = null

/**
 * Set the global log manager instance.
 */
export function setLogManager(manager: LogManager): void {
  globalLogManager = manager
}

/**
 * Get the global log manager instance.
 */
export function getLogManager(): LogManager {
  if (!globalLogManager) {
    throw new Error('Log manager has not been initialized. Call setLogManager() first.')
  }
  return globalLogManager
}
