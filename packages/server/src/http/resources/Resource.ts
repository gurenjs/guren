import type { ResourceData, ResourceClass } from './types'

/**
 * Abstract base class for API resources: transforms model data into an API
 * response payload. `TData` names what `toArray()` builds, so `toJSON()` reports
 * it too; it defaults to `ResourceData` so `Resource<T>` and narrowing overrides
 * keep compiling. `TData` is a claim about `toArray()` only — `additional()` is
 * spread *after* the payload, so a colliding key overwrites a typed field.
 */
export abstract class Resource<T, TData extends ResourceData = ResourceData> {
  protected resource: T

  protected additionalData: ResourceData = {}

  constructor(resource: T) {
    this.resource = resource
  }

  abstract toArray(): TData

  toJSON(): TData {
    return {
      ...this.toArray(),
      ...this.additionalData,
    }
  }

  /** Keys merged beside the payload, overriding colliding `toArray()` keys. */
  additional(data: ResourceData): this {
    this.additionalData = { ...this.additionalData, ...data }
    return this
  }

  when<V>(condition: boolean, value: V | (() => V)): V | undefined {
    if (!condition) {
      return undefined
    }
    return typeof value === 'function' ? (value as () => V)() : value
  }

  whenOr<V>(condition: boolean, value: V | (() => V), defaultValue: V): V {
    if (!condition) {
      return defaultValue
    }
    return typeof value === 'function' ? (value as () => V)() : value
  }

  /** Loaded means the relation key is present and not `undefined`. */
  whenLoaded<V>(
    relation: string,
    value: V | (() => V),
    defaultValue?: V
  ): V | undefined {
    const resource = this.resource as Record<string, unknown>

    const isLoaded = relation in resource && resource[relation] !== undefined

    if (!isLoaded) {
      return defaultValue
    }

    return typeof value === 'function' ? (value as () => V)() : value
  }

  whenNotNull<V>(value: V | null | undefined): V | undefined {
    return value ?? undefined
  }

  merge(data: ResourceData): ResourceData {
    return { ...this.toArray(), ...data }
  }

  static make<T, R extends Resource<T>>(
    this: new (resource: T) => R,
    resource: T
  ): R {
    return new this(resource)
  }

  static collection<T, R extends Resource<T>>(
    this: new (resource: T) => R,
    resources: T[]
  ): ResourceData[] {
    return resources.map((resource) => new this(resource).toJSON())
  }
}

/** Create a resource collection from a resource class. */
export function collect<T, R extends Resource<T>>(
  resources: T[],
  resourceClass: ResourceClass<T, R>
): ResourceData[] {
  return resources.map((resource) => new resourceClass(resource).toJSON())
}

/** Simple resource wrapper for objects that need no transformation. */
export class JsonResource<T extends Record<string, unknown>> extends Resource<T> {
  toArray(): ResourceData {
    return { ...this.resource }
  }
}
