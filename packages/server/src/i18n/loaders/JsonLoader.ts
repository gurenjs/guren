import { readdir, readFile } from 'node:fs/promises'
import { join, basename, extname } from 'node:path'
import type { TranslationLoader, TranslationMessages } from '../types'

/**
 * JSON file-based translation loader: `<path>/<locale>/<namespace>.json`.
 * That layout is a contract shared with the CLI — `guren codegen` and
 * `guren check --i18n` re-implement the same walk statically, so a change to
 * the layout or the parse tolerance has to be made in all three.
 */
export class JsonLoader implements TranslationLoader {
  private basePath: string
  private cache: Map<string, TranslationMessages> = new Map()
  private useCache: boolean

  constructor(basePath: string, options: { cache?: boolean } = {}) {
    this.basePath = basePath
    this.useCache = options.cache ?? true
  }

  async load(locale: string): Promise<TranslationMessages> {
    const cacheKey = locale

    if (this.useCache && this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey)!
    }

    const localePath = join(this.basePath, locale)
    const messages: TranslationMessages = {}

    try {
      const files = await readdir(localePath)

      for (const file of files) {
        if (extname(file) !== '.json') continue

        const namespace = basename(file, '.json')
        const filePath = join(localePath, file)
        const content = await readFile(filePath, 'utf-8')

        try {
          messages[namespace] = JSON.parse(content)
        } catch {
          console.warn(`Failed to parse translation file: ${filePath}`)
        }
      }
    } catch {
    }

    if (this.useCache) {
      this.cache.set(cacheKey, messages)
    }

    return messages
  }

  async loadNamespace(locale: string, namespace: string): Promise<TranslationMessages> {
    const cacheKey = `${locale}:${namespace}`

    if (this.useCache && this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey)!
    }

    const filePath = join(this.basePath, locale, `${namespace}.json`)

    try {
      const content = await readFile(filePath, 'utf-8')
      const messages = JSON.parse(content)

      if (this.useCache) {
        this.cache.set(cacheKey, messages)
      }

      return messages
    } catch {
      return {}
    }
  }

  async getAvailableLocales(): Promise<string[]> {
    try {
      const entries = await readdir(this.basePath, { withFileTypes: true })
      return entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
    } catch {
      return []
    }
  }

  clearCache(): void {
    this.cache.clear()
  }

  setCaching(enabled: boolean): void {
    this.useCache = enabled
    if (!enabled) {
      this.clearCache()
    }
  }
}
