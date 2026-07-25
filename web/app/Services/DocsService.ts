import {
  buildDocSections,
  compareDocs,
  docCategoryTitle,
  normalizeDocCategory,
  normalizeDocSlug,
  DEFAULT_DOC_LOCALE,
  DOC_CATEGORY_KEYS,
  type DocCategoryGroup,
  type DocLocale,
  type DocPage,
} from './docs-config.js'
import { createDefaultDocsStore, type DocsStore } from './DocsStore.js'

export type {
  DocCategory,
  DocCategoryGroup,
  DocLocale,
  DocPage,
  DocSection,
  DocSummary,
} from './docs-config.js'
export {
  DEFAULT_DOC_LOCALE,
  DOC_LOCALE_OPTIONS,
  normalizeDocCategory,
  normalizeDocLocale,
  normalizeDocSlug,
} from './docs-config.js'

export class DocsService {
  #store: Promise<DocsStore> | null = null

  constructor(store?: DocsStore) {
    if (store) {
      this.#store = Promise.resolve(store)
    }
  }

  async listDocs(locale: DocLocale = DEFAULT_DOC_LOCALE): Promise<DocCategoryGroup[]> {
    const store = await this.#resolveStore()

    return Promise.all(
      DOC_CATEGORY_KEYS.map(async (category) => {
        const docs = await store.list(category, locale)
        docs.sort((a, b) => compareDocs(category, a, b))

        return {
          category,
          title: docCategoryTitle(category, locale),
          docs,
          sections: buildDocSections(category, docs, locale),
        }
      }),
    )
  }

  async getDoc(
    category: string | undefined,
    slug: string | undefined,
    locale: DocLocale = DEFAULT_DOC_LOCALE,
  ): Promise<DocPage | null> {
    const normalizedCategory = normalizeDocCategory(category)
    const normalizedSlug = normalizeDocSlug(slug)

    if (!normalizedCategory || !normalizedSlug) {
      return null
    }

    const store = await this.#resolveStore()
    const doc = await store.getRendered(normalizedCategory, normalizedSlug, locale)
    if (!doc) {
      return null
    }

    return { category: normalizedCategory, ...doc }
  }

  /** Raw markdown source for a doc, or null when the doc does not exist. Used by the .md endpoints and llms-full.txt. */
  async getRawMarkdown(
    category: string | undefined,
    slug: string | undefined,
    locale: DocLocale,
  ): Promise<string | null> {
    const normalizedCategory = normalizeDocCategory(category)
    const normalizedSlug = normalizeDocSlug(slug)

    if (!normalizedCategory || !normalizedSlug) {
      return null
    }

    const store = await this.#resolveStore()
    return store.getRaw(normalizedCategory, normalizedSlug, locale)
  }

  #resolveStore(): Promise<DocsStore> {
    if (!this.#store) {
      this.#store = createDefaultDocsStore()
    }

    return this.#store
  }
}

export const docsService = new DocsService()
