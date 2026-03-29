import type { ResourceData, ResourceClass } from './types'
import type { Resource } from './Resource'

/**
 * Collection of resources with additional metadata.
 */
export class ResourceCollection<T, R extends Resource<T>> {
  protected resources: T[]
  protected resourceClass: ResourceClass<T, R>
  protected additionalData: ResourceData = {}
  protected wrapKey: string | null = 'data'

  constructor(resources: T[], resourceClass: ResourceClass<T, R>) {
    this.resources = resources
    this.resourceClass = resourceClass
  }

  /**
   * Transform all resources to an array.
   */
  toArray(): ResourceData[] {
    return this.resources.map((resource) =>
      new this.resourceClass(resource).toJSON()
    )
  }

  /**
   * Add additional data to the collection response.
   */
  additional(data: ResourceData): this {
    this.additionalData = { ...this.additionalData, ...data }
    return this
  }

  /**
   * Set the wrapper key for the collection.
   */
  wrap(key: string | null): this {
    this.wrapKey = key
    return this
  }

  /**
   * Disable wrapping.
   */
  withoutWrapping(): this {
    this.wrapKey = null
    return this
  }

  /**
   * Get the number of resources.
   */
  count(): number {
    return this.resources.length
  }

  /**
   * Check if collection is empty.
   */
  isEmpty(): boolean {
    return this.resources.length === 0
  }

  /**
   * Check if collection is not empty.
   */
  isNotEmpty(): boolean {
    return this.resources.length > 0
  }

  /**
   * Transform to JSON response.
   */
  toJSON(): ResourceData {
    const data = this.toArray()

    if (this.wrapKey === null) {
      return Object.keys(this.additionalData).length > 0
        ? { ...this.additionalData, items: data }
        : (data as unknown as ResourceData)
    }

    return {
      [this.wrapKey]: data,
      ...this.additionalData,
    }
  }

  /**
   * Map over the resources.
   */
  map<U>(callback: (resource: T, index: number) => U): U[] {
    return this.resources.map(callback)
  }

  /**
   * Filter resources.
   */
  filter(callback: (resource: T, index: number) => boolean): ResourceCollection<T, R> {
    return new ResourceCollection(
      this.resources.filter(callback),
      this.resourceClass
    )
  }

  /**
   * Get the underlying resources.
   */
  all(): T[] {
    return this.resources
  }

  /**
   * Create a resource collection.
   */
  static make<T, R extends Resource<T>>(
    resources: T[],
    resourceClass: ResourceClass<T, R>
  ): ResourceCollection<T, R> {
    return new ResourceCollection(resources, resourceClass)
  }
}
