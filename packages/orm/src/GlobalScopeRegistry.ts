import type { QueryBuilder } from './QueryBuilder'
import type { PlainObject } from './Model'

/** A named global scope function. */
export type ScopeFunction = (q: QueryBuilder<any>) => QueryBuilder<any> // eslint-disable-line @typescript-eslint/no-explicit-any

/**
 * Registry for named global scopes on a model.
 *
 * Supports adding, removing, and applying multiple named scopes.
 * Used internally by Model to manage global query constraints.
 */
export class GlobalScopeRegistry {
  private scopes = new Map<string, ScopeFunction>()

  add(name: string, fn: ScopeFunction): void {
    this.scopes.set(name, fn)
  }

  remove(name: string): void {
    this.scopes.delete(name)
  }

  has(name: string): boolean {
    return this.scopes.has(name)
  }

  names(): string[] {
    return Array.from(this.scopes.keys())
  }

  /** Apply all scopes (or all except excluded) to a query builder. */
  apply<T extends PlainObject>(builder: QueryBuilder<T>, except?: string[]): QueryBuilder<T> {
    for (const [name, fn] of this.scopes) {
      if (except && except.includes(name)) continue
      fn(builder)
    }
    return builder
  }

  clear(): void {
    this.scopes.clear()
  }

  /**
   * Copy this registry's entries into a new one.
   *
   * A subclass that registers its own scope needs a registry of its own, but it
   * must keep the ones it inherited: starting from empty is how a model that
   * mixes in `SoftDeletes` and then adds a `tenant` scope silently loses the
   * `softDelete` filter.
   */
  clone(): GlobalScopeRegistry {
    const copy = new GlobalScopeRegistry()
    for (const [name, fn] of this.scopes) {
      copy.add(name, fn)
    }
    return copy
  }

  get size(): number {
    return this.scopes.size
  }
}
