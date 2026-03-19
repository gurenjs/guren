import type { Container } from './Container'

/**
 * Service factory function.
 */
export type ServiceFactory<T> = (container: Container) => T

/**
 * Service class constructor.
 */
export type ServiceClass<T> = new (...args: unknown[]) => T

/**
 * Service binding configuration.
 */
export interface ServiceBinding {
  factory: ServiceFactory<unknown>
  singleton: boolean
  instance?: unknown
}

/**
 * Contextual binding builder interface.
 */
export interface ContextualBindingBuilder {
  needs(abstract: string): ContextualNeedsBuilder
}

/**
 * Contextual needs builder interface.
 */
export interface ContextualNeedsBuilder {
  give<T>(factory: ServiceFactory<T> | T): void
}

/**
 * Contextual binding configuration.
 */
export interface ContextualBinding {
  concrete: string
  needs: string
  factory: ServiceFactory<unknown>
}

/**
 * Service provider options.
 */
export interface ServiceProviderOptions {
  /**
   * Whether this provider should be deferred.
   */
  deferred?: boolean

  /**
   * Services this provider provides (for deferred loading).
   */
  provides?: string[]
}

/**
 * Provider interface for container-based service providers.
 */
export interface Provider {
  register?(context: unknown): void | Promise<void>
  boot?(context: unknown): void | Promise<void>
}

/**
 * Service provider class type.
 */
export interface ServiceProviderClass {
  new (container: Container): Provider
  deferred?: boolean
  provides?: string[]
}
