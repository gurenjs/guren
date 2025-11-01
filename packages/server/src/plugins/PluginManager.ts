import type { Provider, ProviderConstructor } from './Provider'
import type { ApplicationContext } from './ApplicationContext'

interface ProviderEntry {
  instance: Provider
  registered: boolean
  booted: boolean
}

export class PluginManager {
  private readonly entries: ProviderEntry[] = []
  private bootCompleted = false

  constructor(private readonly contextFactory: () => ApplicationContext) {}

  add(provider: Provider | ProviderConstructor): Provider {
    if (this.bootCompleted) {
      throw new Error('Cannot register providers after application has booted.')
    }

    const instance = this.instantiate(provider)
    this.entries.push({ instance, registered: false, booted: false })
    return instance
  }

  addMany(providers: Array<Provider | ProviderConstructor>): void {
    for (const provider of providers) {
      this.add(provider)
    }
  }

  async registerAll(): Promise<void> {
    const context = this.contextFactory()

    for (const entry of this.entries) {
      if (!entry.registered) {
        if (typeof entry.instance.register === 'function') {
          await entry.instance.register(context)
        }
        entry.registered = true
      }
    }
  }

  async bootAll(): Promise<void> {
    const context = this.contextFactory()

    for (const entry of this.entries) {
      if (!entry.booted) {
        if (typeof entry.instance.boot === 'function') {
          await entry.instance.boot(context)
        }
        entry.booted = true
      }
    }

    this.bootCompleted = true
  }

  private instantiate(provider: Provider | ProviderConstructor): Provider {
    if (typeof provider === 'function') {
      return new provider()
    }

    return provider
  }
}
