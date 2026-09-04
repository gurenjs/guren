import type { CacheStore, TaggedCacheStore } from './types'

/** Groups cache items by tags for bulk invalidation. */
export class TaggedCache implements TaggedCacheStore {
  private readonly store: CacheStore
  private readonly tags: string[]
  private readonly tagSetPrefix: string

  constructor(store: CacheStore, tags: string[], tagSetPrefix = 'tag:') {
    this.store = store
    this.tags = tags
    this.tagSetPrefix = tagSetPrefix
  }

  private async getTagNamespace(): Promise<string> {
    const namespaces: string[] = []

    for (const tag of this.tags) {
      const tagKey = `${this.tagSetPrefix}${tag}`
      let namespace = await this.store.get<string>(tagKey)

      if (!namespace) {
        namespace = this.generateNamespace()
        await this.store.set(tagKey, namespace)
      }

      namespaces.push(namespace)
    }

    return namespaces.join(':')
  }

  private generateNamespace(): string {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`
  }

  private async taggedKey(key: string): Promise<string> {
    const namespace = await this.getTagNamespace()
    return `tagged:${namespace}:${key}`
  }

  private async trackKey(key: string): Promise<void> {
    const taggedKey = await this.taggedKey(key)

    for (const tag of this.tags) {
      const setKey = `${this.tagSetPrefix}${tag}:keys`
      const keys = (await this.store.get<string[]>(setKey)) ?? []

      if (!keys.includes(taggedKey)) {
        keys.push(taggedKey)
        await this.store.set(setKey, keys)
      }
    }
  }

  async get<T>(key: string): Promise<T | null> {
    const taggedKey = await this.taggedKey(key)
    return this.store.get<T>(taggedKey)
  }

  async set<T>(key: string, value: T, ttl?: number): Promise<void> {
    const taggedKey = await this.taggedKey(key)
    await this.store.set(taggedKey, value, ttl)
    await this.trackKey(key)
  }

  async has(key: string): Promise<boolean> {
    const taggedKey = await this.taggedKey(key)
    return this.store.has(taggedKey)
  }

  async delete(key: string): Promise<boolean> {
    const taggedKey = await this.taggedKey(key)
    return this.store.delete(taggedKey)
  }

  async clear(): Promise<void> {
    // Only the tagged items, not the entire store.
    await this.flush()
  }

  async increment(key: string, value = 1): Promise<number> {
    const taggedKey = await this.taggedKey(key)
    await this.trackKey(key)
    return this.store.increment(taggedKey, value)
  }

  async decrement(key: string, value = 1): Promise<number> {
    const taggedKey = await this.taggedKey(key)
    await this.trackKey(key)
    return this.store.decrement(taggedKey, value)
  }

  async remember<T>(key: string, ttl: number, callback: () => Promise<T>): Promise<T> {
    const cached = await this.get<T>(key)

    if (cached !== null) {
      return cached
    }

    const value = await callback()
    await this.set(key, value, ttl)
    return value
  }

  async rememberForever<T>(key: string, callback: () => Promise<T>): Promise<T> {
    const cached = await this.get<T>(key)

    if (cached !== null) {
      return cached
    }

    const value = await callback()
    await this.set(key, value)
    return value
  }

  async getMany<T>(keys: string[]): Promise<Map<string, T | null>> {
    const result = new Map<string, T | null>()

    for (const key of keys) {
      result.set(key, await this.get<T>(key))
    }

    return result
  }

  async setMany<T>(items: Map<string, T>, ttl?: number): Promise<void> {
    for (const [key, value] of items) {
      await this.set(key, value, ttl)
    }
  }

  async deleteMany(keys: string[]): Promise<number> {
    let deleted = 0

    for (const key of keys) {
      if (await this.delete(key)) {
        deleted++
      }
    }

    return deleted
  }

  async ttl(key: string): Promise<number> {
    const taggedKey = await this.taggedKey(key)
    return this.store.ttl(taggedKey)
  }

  /** Flush every item carrying the current tags, and the tag namespaces themselves. */
  async flush(): Promise<void> {
    for (const tag of this.tags) {
      const tagKey = `${this.tagSetPrefix}${tag}`
      const setKey = `${this.tagSetPrefix}${tag}:keys`

      const keys = (await this.store.get<string[]>(setKey)) ?? []
      for (const key of keys) {
        await this.store.delete(key)
      }

      await this.store.delete(tagKey)
      await this.store.delete(setKey)
    }
  }

  getTags(): string[] {
    return [...this.tags]
  }

  getStore(): CacheStore {
    return this.store
  }
}
