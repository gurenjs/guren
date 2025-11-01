import type { ApplicationContext } from './ApplicationContext'

export interface Provider {
  register?(context: ApplicationContext): void | Promise<void>
  boot?(context: ApplicationContext): void | Promise<void>
}

export type ProviderConstructor<T extends Provider = Provider> = new () => T
