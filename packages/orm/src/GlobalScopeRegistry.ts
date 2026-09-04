import type { QueryBuilder } from './QueryBuilder'
import type { PlainObject } from './Model'

export type ScopeFunction = (q: QueryBuilder<any>) => QueryBuilder<any> // eslint-disable-line @typescript-eslint/no-explicit-any

/** Registry for the named global scopes applied to every query on a model. */
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
   * A subclass registering its own scope needs a registry of its own, but must
   * keep the inherited entries: starting from empty is how a model that mixes
   * in `SoftDeletes` and then adds a `tenant` scope loses the `softDelete`
   * filter.
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
