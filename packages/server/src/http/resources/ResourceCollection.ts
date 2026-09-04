import type { ResourceData, ResourceClass } from './types'
import type { Resource } from './Resource'

/** Collection of resources with additional metadata. */
export class ResourceCollection<T, R extends Resource<T>> {
  protected resources: T[]
  protected resourceClass: ResourceClass<T, R>
  protected additionalData: ResourceData = {}
  protected wrapKey: string | null = 'data'

  constructor(resources: T[], resourceClass: ResourceClass<T, R>) {
    this.resources = resources
    this.resourceClass = resourceClass
  }

  toArray(): ResourceData[] {
    return this.resources.map((resource) =>
      new this.resourceClass(resource).toJSON()
    )
  }

  /** Keys merged beside the wrapped list. */
  additional(data: ResourceData): this {
    this.additionalData = { ...this.additionalData, ...data }
    return this
  }

  /** Defaults to `'data'`; `null` disables wrapping. */
  wrap(key: string | null): this {
    this.wrapKey = key
    return this
  }

  withoutWrapping(): this {
    this.wrapKey = null
    return this
  }

  count(): number {
    return this.resources.length
  }

  isEmpty(): boolean {
    return this.resources.length === 0
  }

  isNotEmpty(): boolean {
    return this.resources.length > 0
  }

  /** Unwrapped with additional data, the list moves under an `items` key. */
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

  map<U>(callback: (resource: T, index: number) => U): U[] {
    return this.resources.map(callback)
  }

  filter(callback: (resource: T, index: number) => boolean): ResourceCollection<T, R> {
    return new ResourceCollection(
      this.resources.filter(callback),
      this.resourceClass
    )
  }

  /** The untransformed records. */
  all(): T[] {
    return this.resources
  }

  static make<T, R extends Resource<T>>(
    resources: T[],
    resourceClass: ResourceClass<T, R>
  ): ResourceCollection<T, R> {
    return new ResourceCollection(resources, resourceClass)
  }
}
