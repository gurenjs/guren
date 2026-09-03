import type { Container } from './Container'

/**
 * Structural type for DI containers, avoiding a hard dependency on Container
 * where only resolution is needed.
 */
export interface ContainerLike {
  make(key: string): unknown
  has?(key: string): boolean
}

export type ServiceFactory<T> = (container: Container) => T

export type ServiceClass<T> = new (...args: unknown[]) => T

export interface ServiceBinding {
  factory: ServiceFactory<unknown>
  singleton: boolean
  instance?: unknown
}

export interface ContextualBindingBuilder {
  needs(abstract: string): ContextualNeedsBuilder
}

export interface ContextualNeedsBuilder {
  give<T>(factory: ServiceFactory<T> | T): void
}

export interface ContextualBinding {
  concrete: string
  needs: string
  factory: ServiceFactory<unknown>
}

export interface ServiceProviderOptions {
  deferred?: boolean

  /** Services this provider provides, for deferred loading. */
  provides?: string[]
}

export interface Provider {
  register?(context: unknown): void | Promise<void>
  boot?(context: unknown): void | Promise<void>
}

export interface ServiceProviderClass {
  new (container: Container): Provider
  deferred?: boolean
  provides?: string[]
}
