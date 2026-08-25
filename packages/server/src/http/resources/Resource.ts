import type { ResourceData, ResourceClass } from './types'

/**
 * Abstract base class for API resources.
 * Transforms model data into API response format.
 *
 * `TData` names the payload `toArray()` builds, so `toJSON()` reports it too:
 * `class PostResource extends Resource<PostRecord, PostResourceData>`. Without
 * it every subclass had to restate the payload in an override whose only body
 * was `return super.toJSON() as PostResourceData` — a cast that says nothing a
 * type parameter cannot, and one nothing checks against the `toArray()` right
 * above it.
 *
 * It defaults to `ResourceData` so `Resource<T>` and those overrides keep
 * compiling: an override narrowing the return type stays assignable to the
 * base. The polymorphic alternative (`toJSON(): ReturnType<this['toArray']>`)
 * needs no parameter at all but rejects every existing override, which is a
 * breaking change for code the scaffolds have been emitting all along.
 *
 * `TData` is a claim about `toArray()`, not about `toJSON()`'s every key:
 * `additional()` takes arbitrary `ResourceData` and is spread *after* the
 * payload, so a key that collides overwrites a typed field while the return
 * type still reads `TData`. That hole is not new — it is what the
 * `super.toJSON() as PostResourceData` override asserted past — but the type
 * parameter does not close it. `additional()` is for keys beside the payload.
 */
export abstract class Resource<T, TData extends ResourceData = ResourceData> {
  /**
   * The underlying resource.
   */
  protected resource: T

  /**
   * Additional data to merge with the resource.
   */
  protected additionalData: ResourceData = {}

  constructor(resource: T) {
    this.resource = resource
  }

  /**
   * Transform the resource into an array/object.
   * Must be implemented by subclasses.
   */
  abstract toArray(): TData

  /**
   * Transform the resource to JSON.
   */
  toJSON(): TData {
    return {
      ...this.toArray(),
      ...this.additionalData,
    }
  }

  /**
   * Add additional data to the resource.
   */
  additional(data: ResourceData): this {
    this.additionalData = { ...this.additionalData, ...data }
    return this
  }

  /**
   * Conditionally include a value.
   */
  when<V>(condition: boolean, value: V | (() => V)): V | undefined {
    if (!condition) {
      return undefined
    }
    return typeof value === 'function' ? (value as () => V)() : value
  }

  /**
   * Conditionally include a value with a default.
   */
  whenOr<V>(condition: boolean, value: V | (() => V), defaultValue: V): V {
    if (!condition) {
      return defaultValue
    }
    return typeof value === 'function' ? (value as () => V)() : value
  }

  /**
   * Include a value only if a relation is loaded.
   */
  whenLoaded<V>(
    relation: string,
    value: V | (() => V),
    defaultValue?: V
  ): V | undefined {
    const resource = this.resource as Record<string, unknown>

    // Check if relation exists and is not undefined
    const isLoaded = relation in resource && resource[relation] !== undefined

    if (!isLoaded) {
      return defaultValue
    }

    return typeof value === 'function' ? (value as () => V)() : value
  }

  /**
   * Include a value only if it's not null/undefined.
   */
  whenNotNull<V>(value: V | null | undefined): V | undefined {
    return value ?? undefined
  }

  /**
   * Merge another resource's data.
   */
  merge(data: ResourceData): ResourceData {
    return { ...this.toArray(), ...data }
  }

  /**
   * Create a new resource instance.
   */
  static make<T, R extends Resource<T>>(
    this: new (resource: T) => R,
    resource: T
  ): R {
    return new this(resource)
  }

  /**
   * Create a collection of resources.
   */
  static collection<T, R extends Resource<T>>(
    this: new (resource: T) => R,
    resources: T[]
  ): ResourceData[] {
    return resources.map((resource) => new this(resource).toJSON())
  }
}

/**
 * Create a resource collection from a resource class.
 */
export function collect<T, R extends Resource<T>>(
  resources: T[],
  resourceClass: ResourceClass<T, R>
): ResourceData[] {
  return resources.map((resource) => new resourceClass(resource).toJSON())
}

/**
 * Simple resource wrapper for objects without transformation.
 */
export class JsonResource<T extends Record<string, unknown>> extends Resource<T> {
  toArray(): ResourceData {
    return { ...this.resource }
  }
}
