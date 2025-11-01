import { Hono } from 'hono'
import type { MiddlewareHandler, ExecutionContext } from 'hono'
import { Route } from '../mvc/Route'
import { ApplicationContext } from '../plugins/ApplicationContext'
import { PluginManager } from '../plugins/PluginManager'
import type { Provider, ProviderConstructor } from '../plugins/Provider'
import { InertiaViewProvider } from '../plugins/providers/InertiaViewProvider'
import { AuthServiceProvider } from '../plugins/providers/AuthServiceProvider'
import { AuthManager } from '../auth'

// Bun is only available at runtime. The declaration keeps TypeScript happy while
// still allowing consumers to stub or polyfill it when running elsewhere.
declare const Bun:
  | {
    serve(options: {
      port?: number
      hostname?: string
      fetch: (request: Request) => Response | Promise<Response>
    }): unknown
  }
  | undefined

export type BootCallback = (app: Hono) => void | Promise<void>

export interface ApplicationOptions {
  readonly boot?: BootCallback
  readonly providers?: Array<Provider | ProviderConstructor>
}

/**
 * Application wires the Route registry into a running Hono instance.
 * It offers a small convenience layer so users can bootstrap a Bun server
 * without touching the underlying Hono object directly.
 */
export class Application {
  readonly hono: Hono
  private readonly plugins: PluginManager
  private context?: ApplicationContext
  private readonly authManager: AuthManager

  constructor(private readonly options: ApplicationOptions = {}) {
    this.hono = new Hono()
    this.authManager = new AuthManager()
    this.plugins = new PluginManager(() => this.resolveContext())

    this.registerDefaultProviders()

    if (Array.isArray(this.options.providers)) {
      this.plugins.addMany(this.options.providers)
    }
  }

  get auth(): AuthManager {
    return this.authManager
  }

  /**
   * Mounts all routes that were defined through the Route DSL.
   */
  mountRoutes(): void {
    Route.mount(this.hono)
  }

  /**
   * Allows registering global middlewares directly on the underlying Hono app.
   */
  use(path: string, ...middleware: MiddlewareHandler[]): void {
    this.hono.use(path, ...middleware)
  }

  /**
   * Executes the optional boot callback and mounts the registered routes.
   */
  async boot(): Promise<void> {
    await this.plugins.registerAll()
    await this.options.boot?.(this.hono)
    this.mountRoutes()
    await this.plugins.bootAll()
  }

  /**
   * Fetch handler to integrate with Bun.serve or any standard Fetch runtime.
   */
  async fetch(request: Request, env?: unknown, executionCtx?: ExecutionContext): Promise<Response> {
    return this.hono.fetch(request, env, executionCtx)
  }

  /**
   * Convenience helper to start a Bun server when available.
   */
  listen(options: { port?: number; hostname?: string } = {}): void {
    if (!Bun) {
      throw new Error('Bun runtime is required to call Application.listen')
    }

    const { port = 3000, hostname = '0.0.0.0' } = options

    Bun.serve({
      port,
      hostname,
      fetch: (request: Request) => this.fetch(request),
    })
  }

  register(provider: Provider | ProviderConstructor): this {
    this.plugins.add(provider)
    return this
  }

  registerMany(providers: Array<Provider | ProviderConstructor>): this {
    this.plugins.addMany(providers)
    return this
  }

  private resolveContext(): ApplicationContext {
    if (!this.context) {
      this.context = new ApplicationContext(this, this.authManager)
    }

    return this.context
  }

  private registerDefaultProviders(): void {
    this.plugins.add(InertiaViewProvider)
    this.plugins.add(AuthServiceProvider)
  }
}

export type { Context } from 'hono'
