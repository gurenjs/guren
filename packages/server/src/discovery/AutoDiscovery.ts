import { join } from 'path'

declare const Bun: {
  Glob: new (pattern: string) => {
    scan(options: { cwd: string; absolute: true }): AsyncIterable<string>
  }
}

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

export interface DiscoveryResult {
  providers: Array<new (...args: unknown[]) => unknown>
  listeners: Array<{ event: string; listener: new () => unknown }>
  jobs: Array<new () => unknown>
  events: Array<new () => unknown>
}

/**
 * Scans application directories for providers, listeners, jobs and events via
 * `Bun.Glob` and dynamic `import()`. Standalone by design: nothing in
 * `Application` runs it, so registration stays explicit — what `guren check`
 * verifies and what bundle-deploy targets (Workers, Vercel, Lambda) require,
 * since a runtime directory scan finds nothing in a bundle.
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

  async discover(): Promise<DiscoveryResult> {
    const [providers, listeners, jobs, events] = await Promise.all([
      this.options.providers ? this.discoverProviders() : Promise.resolve([]),
      this.options.listeners ? this.discoverListeners() : Promise.resolve([]),
      this.options.jobs ? this.discoverJobs() : Promise.resolve([]),
      this.options.events ? this.discoverEvents() : Promise.resolve([]),
    ])

    return { providers, listeners, jobs, events }
  }

  /** `app/Providers/`: any exported class with a `register` method. */
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

  /** `app/Listeners/`: classes with a string `static event` and a `handle` method. */
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

  /** `app/Jobs/`: classes with a `handle` method. */
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

  /** `app/Events/`: every exported class counts. */
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

  /** Imports every `.ts` file in the directory, skipping `index.ts` barrels. */
  private async scanDirectory(dir: string): Promise<Record<string, unknown>[]> {
    const modules: Record<string, unknown>[] = []

    try {
      const glob = new Bun.Glob('**/*.ts')

      for await (const file of glob.scan({ cwd: dir, absolute: true })) {
        if (file.endsWith('/index.ts') || file.endsWith('\\index.ts')) {
          continue
        }

        try {
          const mod = (await import(file)) as Record<string, unknown>
          modules.push(mod)
        } catch {
          // A module that fails to import (missing dependency) is skipped.
          continue
        }
      }
    } catch {
      // Directory does not exist or is not readable — skip silently
    }

    return modules
  }

  private extractClasses(mod: Record<string, unknown>): Array<new (...args: unknown[]) => unknown> {
    const classes: Array<new (...args: unknown[]) => unknown> = []

    for (const exportValue of Object.values(mod)) {
      if (this.isConstructor(exportValue)) {
        classes.push(exportValue as new (...args: unknown[]) => unknown)
      }
    }

    return classes
  }

  private isConstructor(value: unknown): boolean {
    if (typeof value !== 'function') {
      return false
    }

    // A class's prototype points its constructor back at the class.
    const proto = value.prototype
    return proto !== undefined && proto.constructor === value
  }

  private isProvider(cls: new (...args: unknown[]) => unknown): boolean {
    return typeof cls.prototype.register === 'function'
  }

  private getStaticEvent(cls: new (...args: unknown[]) => unknown): string | null {
    const eventProp = (cls as unknown as Record<string, unknown>).event
    if (typeof eventProp === 'string' && eventProp.length > 0) {
      return eventProp
    }
    return null
  }

  private hasHandleMethod(cls: new (...args: unknown[]) => unknown): boolean {
    return typeof cls.prototype.handle === 'function'
  }
}
