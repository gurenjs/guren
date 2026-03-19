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

/**
 * Mail manager for handling multiple transports.
 *
 * @example
 * ```ts
 * const mailManager = new MailManager({
 *   default: 'smtp',
 *   from: { email: 'noreply@example.com', name: 'MyApp' },
 *   transports: {
 *     smtp: {
 *       driver: 'smtp',
 *       host: 'smtp.example.com',
 *       port: 587,
 *       auth: { user: 'user', pass: 'pass' },
 *     },
 *     resend: {
 *       driver: 'resend',
 *       apiKey: 'your-api-key',
 *     },
 *   },
 * })
 *
 * // Get the default transport
 * const transport = mailManager.transport()
 *
 * // Get a specific transport
 * const resendTransport = mailManager.transport('resend')
 * ```
 */
export class MailManager {
  private readonly defaultTransportName: string
  private readonly defaultFrom?: MailAddress
  private readonly transportFactories: Map<string, MailTransportFactory> = new Map()
  private readonly resolvedTransports: Map<string, MailTransport> = new Map()

  constructor(config: MailConfig = {}) {
    this.defaultTransportName = config.default ?? 'smtp'
    this.defaultFrom = config.from

    // Register built-in drivers
    this.registerBuiltinDrivers()

    // Register transports from config
    if (config.transports) {
      for (const [name, transportConfig] of Object.entries(config.transports)) {
        this.registerTransportFromConfig(name, transportConfig)
      }
    }
  }

  /**
   * Register built-in transport drivers.
   */
  private registerBuiltinDrivers(): void {
    // SMTP driver factory
    this.registerDriverFactory('smtp', (options: SmtpTransportOptions) => {
      return new SmtpTransport(options)
    })

    // Resend driver factory
    this.registerDriverFactory('resend', (options: ResendTransportOptions) => {
      return new ResendTransport(options)
    })

    // Memory driver factory
    this.registerDriverFactory('memory', (options?: MemoryTransportOptions) => {
      return new MemoryTransport(options)
    })
  }

  private driverFactories: Map<string, (options: any) => MailTransport> = new Map()

  /**
   * Register a driver factory.
   */
  private registerDriverFactory<T>(
    driver: string,
    factory: (options: T) => MailTransport
  ): void {
    this.driverFactories.set(driver, factory)
  }

  /**
   * Register a transport from configuration.
   */
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

  /**
   * Get a mail transport by name.
   * Returns the default transport if no name is specified.
   */
  transport(name?: string): MailTransport {
    const transportName = name ?? this.defaultTransportName

    // Return cached transport if already resolved
    const cached = this.resolvedTransports.get(transportName)
    if (cached) {
      return cached
    }

    // Get factory and create transport
    const factory = this.transportFactories.get(transportName)
    if (!factory) {
      throw new Error(`Mail transport not found: ${transportName}`)
    }

    const transport = factory()
    this.resolvedTransports.set(transportName, transport)
    return transport
  }

  /**
   * Register a custom transport.
   */
  registerTransport(name: string, factory: MailTransportFactory): void {
    this.transportFactories.set(name, factory)
    // Clear cached instance if exists
    this.resolvedTransports.delete(name)
  }

  /**
   * Check if a transport is registered.
   */
  hasTransport(name: string): boolean {
    return this.transportFactories.has(name)
  }

  /**
   * Get the default transport name.
   */
  getDefaultTransportName(): string {
    return this.defaultTransportName
  }

  /**
   * Get the default from address.
   */
  getDefaultFrom(): MailAddress | undefined {
    return this.defaultFrom
  }

  /**
   * Get all registered transport names.
   */
  getTransportNames(): string[] {
    return Array.from(this.transportFactories.keys())
  }
}

/**
 * Create a mail manager with configuration.
 */
export function createMailManager(config?: MailConfig): MailManager {
  return new MailManager(config)
}
