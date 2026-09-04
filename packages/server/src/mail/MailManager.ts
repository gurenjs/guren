import type {
  MailTransport,
  MailTransportFactory,
  MailConfig,
  MailAddress,
  SmtpTransportOptions,
  ResendTransportOptions,
  MemoryTransportOptions,
} from './types'
import { SmtpTransport } from './transports/SmtpTransport'
import { ResendTransport } from './transports/ResendTransport'
import { MemoryTransport } from './transports/MemoryTransport'
import { LogTransport, type LogTransportOptions } from './transports/LogTransport'

/** Mail manager for handling multiple transports. */
export class MailManager {
  private readonly defaultTransportName: string
  private readonly defaultFrom?: MailAddress
  private readonly transportFactories: Map<string, MailTransportFactory> = new Map()
  private readonly resolvedTransports: Map<string, MailTransport> = new Map()

  constructor(config: MailConfig = {}) {
    this.defaultTransportName = config.default ?? 'smtp'
    this.defaultFrom = config.from

    this.registerBuiltinDrivers()

    if (config.transports) {
      for (const [name, transportConfig] of Object.entries(config.transports)) {
        this.registerTransportFromConfig(name, transportConfig)
      }
    }
  }

  private registerBuiltinDrivers(): void {
    this.registerDriverFactory('smtp', (options: SmtpTransportOptions) => {
      return new SmtpTransport(options)
    })

    this.registerDriverFactory('resend', (options: ResendTransportOptions) => {
      return new ResendTransport(options)
    })

    this.registerDriverFactory('memory', (options?: MemoryTransportOptions) => {
      return new MemoryTransport(options)
    })

    // Development default.
    this.registerDriverFactory('log', (options?: LogTransportOptions) => {
      return new LogTransport(options)
    })
  }

  private driverFactories: Map<string, (options: any) => MailTransport> = new Map()

  private registerDriverFactory<T>(
    driver: string,
    factory: (options: T) => MailTransport
  ): void {
    this.driverFactories.set(driver, factory)
  }

  private registerTransportFromConfig(
    name: string,
    config: { driver: string; [key: string]: unknown }
  ): void {
    const { driver, ...options } = config
    const factory = this.driverFactories.get(driver)

    if (!factory) {
      throw new Error(`Unknown mail driver: ${driver}`)
    }

    this.transportFactories.set(name, () => factory(options))
  }

  /** Get a mail transport by name, or the default transport when unnamed. */
  transport(name?: string): MailTransport {
    const transportName = name ?? this.defaultTransportName

    const cached = this.resolvedTransports.get(transportName)
    if (cached) {
      return cached
    }

    const factory = this.transportFactories.get(transportName)
    if (!factory) {
      throw new Error(`Mail transport not found: ${transportName}`)
    }

    const transport = factory()
    this.resolvedTransports.set(transportName, transport)
    return transport
  }

  registerTransport(name: string, factory: MailTransportFactory): void {
    this.transportFactories.set(name, factory)
    this.resolvedTransports.delete(name)
  }

  hasTransport(name: string): boolean {
    return this.transportFactories.has(name)
  }

  getDefaultTransportName(): string {
    return this.defaultTransportName
  }

  getDefaultFrom(): MailAddress | undefined {
    return this.defaultFrom
  }

  getTransportNames(): string[] {
    return Array.from(this.transportFactories.keys())
  }
}

export function createMailManager(config?: MailConfig): MailManager {
  return new MailManager(config)
}
