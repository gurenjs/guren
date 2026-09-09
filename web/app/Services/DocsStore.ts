// Storage abstraction behind DocsService. In production the docs are files
// under public/ (see docs-manifest.ts) read through an AssetReader; the
// manifest module is the only docs data the bundle carries. FsDocsStore
// renders live from docs/ and is dynamically imported only when selected, so
// the renderer never ships to production.
import { getWorkersEnv, isWorkersRuntime } from '@guren/plugin-cloudflare/env'

import { docsManifest } from '@/.guren/docs-manifest.gen.js'

import type { AssetsBindingLike, WorkersEnv } from '../../config/workers-env.js'
import { shouldUsePrerendered, type DocCategory, type DocLocale, type DocSummary } from './docs-config.js'
import {
  docFragmentPath,
  docMarkdownPath,
  LLMS_FULL_PATH,
  type DocFragment,
  type DocManifestEntry,
  type DocsManifest,
} from './docs-manifest.js'

export interface RenderedDoc extends DocSummary {
  html: string
}

export interface DocsStore {
  list(category: DocCategory, locale: DocLocale): Promise<DocSummary[]>
  getRendered(category: DocCategory, slug: string, locale: DocLocale): Promise<RenderedDoc | null>
  getRaw(category: DocCategory, slug: string, locale: DocLocale): Promise<string | null>
  /** The prebuilt llms-full.txt, where the store has one; DocsService builds it live otherwise. */
  getLlmsFull?(): Promise<string>
}

/** Text of the file at a public path (`/_docs/en/guides/routing.json`), or null when there is none. */
export type AssetReader = (path: string) => Promise<string | null>

/**
 * The manifest names a doc whose file is not there: a build that wrote one
 * without the other. A 503 rather than a 404, which would present a broken
 * deploy as a page that never existed.
 */
export class DocsAssetUnavailableError extends Error {
  readonly statusCode = 503

  constructor(path: string) {
    super(
      `The docs manifest names ${path}, but no such asset was deployed. ` +
        'Run `bun run prerender` and redeploy: the manifest and public/ are written by the same build.',
    )
    this.name = 'DocsAssetUnavailableError'
  }
}

export class AssetDocsStore implements DocsStore {
  #manifest: DocsManifest
  #read: AssetReader

  constructor(manifest: DocsManifest, read: AssetReader) {
    this.#manifest = manifest
    this.#read = read
  }

  async list(category: DocCategory, locale: DocLocale): Promise<DocSummary[]> {
    const docs = this.#manifest.docs[locale]?.[category] ?? {}

    return Object.entries(docs).map(([slug, entry]) => summary(slug, entry))
  }

  async getRendered(
    category: DocCategory,
    slug: string,
    locale: DocLocale,
  ): Promise<RenderedDoc | null> {
    if (!this.#entry(locale, category, slug)) {
      return null
    }

    const fragment = JSON.parse(await this.#require(docFragmentPath(locale, category, slug))) as DocFragment

    return { ...summary(slug, fragment), html: fragment.html }
  }

  async getRaw(category: DocCategory, slug: string, locale: DocLocale): Promise<string | null> {
    if (!this.#entry(locale, category, slug)) {
      return null
    }

    return this.#require(docMarkdownPath(locale, category, slug))
  }

  async getLlmsFull(): Promise<string> {
    return this.#require(LLMS_FULL_PATH)
  }

  #entry(locale: DocLocale, category: DocCategory, slug: string): DocManifestEntry | undefined {
    return this.#manifest.docs[locale]?.[category]?.[slug]
  }

  async #require(path: string): Promise<string> {
    const text = await this.#read(path)
    if (text === null) {
      throw new DocsAssetUnavailableError(path)
    }
    return text
  }
}

function summary(slug: string, entry: DocManifestEntry): DocSummary {
  return {
    slug,
    title: entry.title,
    ...(entry.description !== undefined ? { description: entry.description } : {}),
  }
}

/**
 * Read through the ASSETS binding. Any host name works, only the path is
 * matched. The status is the whole signal: a `_headers` rule matching the
 * path decorates a 404 too, so nothing else about the response says "missing".
 */
export function createWorkersAssetReader(assets: () => AssetsBindingLike): AssetReader {
  return async (path) => {
    const response = await assets().fetch(`https://assets.local${path}`)
    if (response.status === 404) {
      await response.body?.cancel()
      return null
    }
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error(`Workers Static Assets answered ${response.status} for ${path}`)
    }
    return response.text()
  }
}

export async function createDefaultDocsStore(): Promise<DocsStore> {
  if (shouldUsePrerendered(docsManifest.prerendered)) {
    return new AssetDocsStore(docsManifest, await createAssetReader())
  }

  const { FsDocsStore } = await import('./FsDocsStore.js')
  return new FsDocsStore()
}

async function createAssetReader(): Promise<AssetReader> {
  if (isWorkersRuntime()) {
    // Resolved per read, not here: the env is captured by the first request,
    // and this runs inside one, but a store built once must not pin it.
    return createWorkersAssetReader(() => getWorkersEnv<WorkersEnv>().ASSETS)
  }

  const { createPublicFileReader } = await import('./public-file-reader.js')
  return createPublicFileReader()
}
