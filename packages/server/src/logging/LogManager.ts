import type { LogConfig, LogChannel, LogChannelFactory } from './types'
import { Logger, isPromiseLike, type LoggerOptions } from './Logger'
import { ConsoleChannel } from './channels/ConsoleChannel'
import { FileChannel } from './channels/FileChannel'
import { DailyFileChannel } from './channels/DailyFileChannel'

/** Log manager for managing multiple logging channels. */
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
      return this.createStackChannel(config as any)
    })
  }

  private createStackChannel(config: { channels: string[] }): LogChannel {
    const channels = config.channels.map((name) => this.resolveChannel(name))
    return {
      log: (entry) => {
        // Every member is called, and every rejection is handled the moment it
        // is seen, whatever a later member does: a sync throw from member B
        // must not leave member A's rejection unhandled. Failures are gathered
        // and rethrown once, synchronously when no member went async so a
        // sync-only stack stays sync, otherwise after all members settled.
        const failures: unknown[] = []
        const pending: Promise<void>[] = []
        for (const channel of channels) {
          try {
            const result = channel.log(entry)
            if (isPromiseLike(result)) {
              pending.push(Promise.resolve(result).then(() => undefined, (error: unknown) => { failures.push(error) }))
            }
          } catch (error) {
            failures.push(error)
          }
        }
        const rethrow = (): void => {
          if (failures.length === 1) throw failures[0]
          if (failures.length > 1) throw new AggregateError(failures, `${failures.length} of ${channels.length} stack channels failed`)
        }
        if (pending.length === 0) {
          rethrow()
          return
        }
        return Promise.all(pending).then(rethrow)
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

  registerDriver(name: string, factory: LogChannelFactory): void {
    this.channelFactories.set(name, factory)
  }

  channel(name?: string): Logger {
    const channelName = name ?? this.config.default

    if (!this.loggers.has(channelName)) {
      const channel = this.resolveChannel(channelName)
      this.loggers.set(channelName, new Logger([channel], {}, this.loggerOptions))
    }

    return this.loggers.get(channelName)!
  }

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

  withContext(context: Record<string, unknown>): Logger {
    return this.channel().withContext(context)
  }

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

  async close(): Promise<void> {
    for (const channel of this.channelInstances.values()) {
      if (channel.close) {
        await channel.close()
      }
    }
    this.channelInstances.clear()
    this.loggers.clear()
  }

  getDefaultChannel(): string {
    return this.config.default
  }

  getChannelNames(): string[] {
    return Object.keys(this.config.channels)
  }
}

export function createLogManager(config: LogConfig): LogManager {
  return new LogManager(config)
}

let globalLogManager: LogManager | null = null

export function setLogManager(manager: LogManager): void {
  globalLogManager = manager
}

export function getLogManager(): LogManager {
  if (!globalLogManager) {
    throw new Error('Log manager has not been initialized. Call setLogManager() first.')
  }
  return globalLogManager
}
