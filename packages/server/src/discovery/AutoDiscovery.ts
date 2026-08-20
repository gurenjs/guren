import { join } from 'path'

declare const Bun: {
  Glob: new (pattern: string) => {
    scan(options: { cwd: string; absolute: true }): AsyncIterable<string>
  }
}

/**
 * Options for configuring the auto-discovery engine.
 */
export interface DiscoveryOptions {
  /** Base path for scanning. Defaults to `process.cwd()`. */
  basePath?: string
  /** Whether to discover service providers in `app/Providers/`. Defaults to `true`. */
  providers?: boolean
  /** Whether to discover event listeners in `app/Listeners/`. Defaults to `true`. */
  listeners?: boolean
  /** Whether to discover jobs in `app/Jobs/`. Defaults to `true`. */
  jobs?: boolean
  /** Whether to discover events in `app/Events/`. Defaults to `true`. */
  events?: boolean
}

/**
 * Result of the auto-discovery scan.
 */
export interface DiscoveryResult {
  /** Discovered service provider classes. */
  providers: Array<new (...args: unknown[]) => unknown>
  /** Discovered event listeners with their associated event name. */
  listeners: Array<{ event: string; listener: new () => unknown }>
  /** Discovered job classes. */
  jobs: Array<new () => unknown>
  /** Discovered event classes. */
  events: Array<new () => unknown>
}

/**
 * Auto-discovery engine that scans application directories and discovers
 * framework components (providers, listeners, jobs, events).
 *
 * Standalone by design: nothing in `Application` runs this scan, so
 * registration stays explicit — `createApp({ providers: [...] })`, and
 * `defineModule` lists for modules — which is what `guren check` verifies
 * and what bundle-deploy targets (Workers, Vercel, Lambda) require, since a
 * runtime directory scan finds nothing in a bundle. A caller that wants
 * discovery runs the scan itself and feeds each result into the matching
 * registry, as the example below does.
 *
 * Uses `Bun.Glob` to scan directories and dynamic `import()` to load modules.
 *
 * @example
 * ```typescript
 * const discovery = new AutoDiscovery({ basePath: '/app' })
 * const result = await discovery.discover()
 *
 * // Register discovered providers
 * for (const ProviderClass of result.providers) {
 *   providerManager.register(ProviderClass)
 * }
 *
 * // Register discovered listeners
 * for (const { event, listener } of result.listeners) {
 *   eventManager.listen(event, listener)
 * }
 * ```
 */
export class AutoDiscovery {
  private basePath: string
  private options: Required<Omit<DiscoveryOptions, 'basePath'>>

  constructor(options: DiscoveryOptions = {}) {
    this.basePath = options.basePath ?? process.cwd()
    this.options = {
      providers: options.providers ?? true,
      listeners: options.listeners ?? true,
      jobs: options.jobs ?? true,
      events: options.events ?? true,
    }
  }

  /**
   * Run the discovery scan across all enabled directories.
   */
  async discover(): Promise<DiscoveryResult> {
    const [providers, listeners, jobs, events] = await Promise.all([
      this.options.providers ? this.discoverProviders() : Promise.resolve([]),
      this.options.listeners ? this.discoverListeners() : Promise.resolve([]),
      this.options.jobs ? this.discoverJobs() : Promise.resolve([]),
      this.options.events ? this.discoverEvents() : Promise.resolve([]),
    ])

    return { providers, listeners, jobs, events }
  }

  /**
   * Discover service providers in `app/Providers/`.
   *
   * A module is considered a provider if it exports a class (default or named)
   * that has a `register` method (i.e., implements the Provider interface).
   */
  private async discoverProviders(): Promise<Array<new (...args: unknown[]) => unknown>> {
    const dir = join(this.basePath, 'app', 'Providers')
    const modules = await this.scanDirectory(dir)
    const providers: Array<new (...args: unknown[]) => unknown> = []

    for (const mod of modules) {
      const classes = this.extractClasses(mod)
      for (const cls of classes) {
        if (this.isProvider(cls)) {
          providers.push(cls)
        }
      }
    }

    return providers
  }

  /**
   * Discover event listeners in `app/Listeners/`.
   *
   * A listener class must have a `static event` property (string) that indicates
   * which event it handles, and a `handle` method.
   */
  private async discoverListeners(): Promise<
    Array<{ event: string; listener: new () => unknown }>
  > {
    const dir = join(this.basePath, 'app', 'Listeners')
    const modules = await this.scanDirectory(dir)
    const listeners: Array<{ event: string; listener: new () => unknown }> = []

    for (const mod of modules) {
      const classes = this.extractClasses(mod)
      for (const cls of classes) {
        const eventName = this.getStaticEvent(cls)
        if (eventName && this.hasHandleMethod(cls)) {
          listeners.push({
            event: eventName,
            listener: cls as new () => unknown,
          })
        }
      }
    }

    return listeners
  }

  /**
   * Discover jobs in `app/Jobs/`.
   *
   * A job class must have a `handle` method.
   */
  private async discoverJobs(): Promise<Array<new () => unknown>> {
    const dir = join(this.basePath, 'app', 'Jobs')
    const modules = await this.scanDirectory(dir)
    const jobs: Array<new () => unknown> = []

    for (const mod of modules) {
      const classes = this.extractClasses(mod)
      for (const cls of classes) {
        if (this.hasHandleMethod(cls)) {
          jobs.push(cls as new () => unknown)
        }
      }
    }

    return jobs
  }

  /**
   * Discover events in `app/Events/`.
   *
   * Any exported class from the Events directory is considered an event class.
   */
  private async discoverEvents(): Promise<Array<new () => unknown>> {
    const dir = join(this.basePath, 'app', 'Events')
    const modules = await this.scanDirectory(dir)
    const events: Array<new () => unknown> = []

    for (const mod of modules) {
      const classes = this.extractClasses(mod)
      for (const cls of classes) {
        events.push(cls as new () => unknown)
      }
    }

    return events
  }

  /**
   * Scan a directory for TypeScript files using Bun.Glob.
   * Returns an array of imported modules. Skips `index.ts` barrel files.
   */
  private async scanDirectory(dir: string): Promise<Record<string, unknown>[]> {
    const modules: Record<string, unknown>[] = []

    try {
      const glob = new Bun.Glob('**/*.ts')

      for await (const file of glob.scan({ cwd: dir, absolute: true })) {
        // Skip index/barrel files
        if (file.endsWith('/index.ts') || file.endsWith('\\index.ts')) {
          continue
        }

        try {
          const mod = (await import(file)) as Record<string, unknown>
          modules.push(mod)
        } catch {
          // Skip modules that fail to import (e.g., missing dependencies)
          continue
        }
      }
    } catch {
      // Directory does not exist or is not readable — skip silently
    }

    return modules
  }

  /**
   * Extract all class constructors (functions) from a module's exports.
   */
  private extractClasses(mod: Record<string, unknown>): Array<new (...args: unknown[]) => unknown> {
    const classes: Array<new (...args: unknown[]) => unknown> = []

    for (const exportValue of Object.values(mod)) {
      if (this.isConstructor(exportValue)) {
        classes.push(exportValue as new (...args: unknown[]) => unknown)
      }
    }

    return classes
  }

  /**
   * Check if a value is a constructor function (class).
   */
  private isConstructor(value: unknown): boolean {
    if (typeof value !== 'function') {
      return false
    }

    // Classes have a prototype with a constructor reference back to themselves
    const proto = value.prototype
    return proto !== undefined && proto.constructor === value
  }

  /**
   * Check if a class looks like a service provider (has a `register` method).
   */
  private isProvider(cls: new (...args: unknown[]) => unknown): boolean {
    return typeof cls.prototype.register === 'function'
  }

  /**
   * Get the `static event` property from a class, if it exists and is a string.
   */
  private getStaticEvent(cls: new (...args: unknown[]) => unknown): string | null {
    const eventProp = (cls as unknown as Record<string, unknown>).event
    if (typeof eventProp === 'string' && eventProp.length > 0) {
      return eventProp
    }
    return null
  }

  /**
   * Check if a class has a `handle` method on its prototype.
   */
  private hasHandleMethod(cls: new (...args: unknown[]) => unknown): boolean {
    return typeof cls.prototype.handle === 'function'
  }
}
