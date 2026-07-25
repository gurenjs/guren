// Storage abstraction behind DocsService. The prebuilt store serves content
// rendered at build time (scripts/prerender-docs.ts) and keeps shiki, marked,
// and node:fs out of the request path; the fs store (FsDocsStore.ts) renders
// live from docs/ and is only loaded via dynamic import when selected, so
// dev keeps live-editing without shipping the renderer to production.
import { docsData, type PrerenderedDocsData } from '@/.guren/docs.gen.js'

import { shouldUsePrerendered, type DocCategory, type DocLocale, type DocSummary } from './docs-config.js'

export interface RenderedDoc extends DocSummary {
  html: string
}

export interface DocsStore {
  list(category: DocCategory, locale: DocLocale): Promise<DocSummary[]>
  getRendered(category: DocCategory, slug: string, locale: DocLocale): Promise<RenderedDoc | null>
  getRaw(category: DocCategory, slug: string, locale: DocLocale): Promise<string | null>
}

/**
 * Prebuilt content is preferred in production (or with GUREN_DOCS_PRERENDERED=1);
 * everywhere else the live renderer keeps docs editable without a rebuild.
 */
export class PrebuiltDocsStore implements DocsStore {
  #data: PrerenderedDocsData

  constructor(data: PrerenderedDocsData = docsData) {
    this.#data = data
  }

  async list(category: DocCategory, locale: DocLocale): Promise<DocSummary[]> {
    const docs = this.#data.docs[locale]?.[category] ?? {}

    return Object.entries(docs).map(([slug, doc]) => ({
      slug,
      title: doc.title,
      ...(doc.description !== undefined ? { description: doc.description } : {}),
    }))
  }

  async getRendered(
    category: DocCategory,
    slug: string,
    locale: DocLocale,
  ): Promise<RenderedDoc | null> {
    const doc = this.#data.docs[locale]?.[category]?.[slug]
    if (!doc) {
      return null
    }

    return {
      slug,
      title: doc.title,
      ...(doc.description !== undefined ? { description: doc.description } : {}),
      html: doc.html,
    }
  }

  async getRaw(category: DocCategory, slug: string, locale: DocLocale): Promise<string | null> {
    return this.#data.docs[locale]?.[category]?.[slug]?.raw ?? null
  }
}

export async function createDefaultDocsStore(): Promise<DocsStore> {
  if (shouldUsePrerendered(docsData.prerendered)) {
    return new PrebuiltDocsStore(docsData)
  }

  const { FsDocsStore } = await import('./FsDocsStore.js')
  return new FsDocsStore()
}
