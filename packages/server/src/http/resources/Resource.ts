import type { ResourceData, ResourceClass } from './types'

/**
 * Abstract base class for API resources.
 * Transforms model data into API response format.
 */
export abstract class Resource<T> {
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
  abstract toArray(): ResourceData

  /**
   * Transform the resource to JSON.
   */
  toJSON(): ResourceData {
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
