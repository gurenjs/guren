// Live filesystem store: reads docs/{en,ja} and renders markdown per request.
// Never import this module statically from the request path — DocsStore.ts
// loads it via dynamic import only when the prebuilt store is not selected.
import { readdir, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

import {
  docCategoryDir,
  docLocaleDir,
  extractDocDescription,
  extractDocTitle,
  type DocCategory,
  type DocLocale,
  type DocSummary,
} from './docs-config.js'
import { renderMarkdownToHtml } from './MarkdownRenderer.js'
import type { DocsStore, RenderedDoc } from './DocsStore.js'

type ResolveDocsDirOptions = {
  importMetaDir?: string
  cwd?: string
  envDocsDir?: string | null
}

function findNearestDocsDir(startDir: string, maxDepth = 6): string | null {
  let currentDir = startDir

  for (let depth = 0; depth < maxDepth; depth += 1) {
    const candidate = resolve(currentDir, 'docs')
    if (existsSync(candidate)) {
      return candidate
    }

    const parent = dirname(currentDir)
    if (parent === currentDir) {
      break
    }
    currentDir = parent
  }

  return null
}

// Resolve docs relative to the repository root so it works regardless of where the server is launched or bundled.
export function resolveDefaultDocsDir(options: ResolveDocsDirOptions = {}): string {
  const envDir = options.envDocsDir ?? process.env.GUREN_DOCS_DIR ?? process.env.DOCS_DIR
  if (envDir) {
    const resolvedEnvDir = resolve(envDir)
    if (existsSync(resolvedEnvDir)) {
      return resolvedEnvDir
    }
  }

  const cwdMatch = findNearestDocsDir(options.cwd ?? process.cwd())
  if (cwdMatch) {
    return cwdMatch
  }

  const importMetaDir = options.importMetaDir ?? import.meta.dirname
  const importMetaMatch = findNearestDocsDir(importMetaDir)
  if (importMetaMatch) {
    return importMetaMatch
  }

  // Fallback to the original heuristic; this keeps behavior stable even if no docs directory is found.
  return resolve(importMetaDir, '../../..', 'docs')
}

export class FsDocsStore implements DocsStore {
  #docsDir: string

  constructor(docsDir: string = resolveDefaultDocsDir()) {
    this.#docsDir = docsDir
  }

  async list(category: DocCategory, locale: DocLocale): Promise<DocSummary[]> {
    const dirPath = resolve(this.#rootForLocale(locale), docCategoryDir(category))
    const entries = await readdir(dirPath, { withFileTypes: true }).catch(() => [])

    return Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
        .map(async (entry) => {
          const slug = entry.name.replace(/\.md$/iu, '')
          const markdown = await this.#readMarkdownBySlug(category, slug, locale)

          return {
            slug,
            title: extractDocTitle(markdown, slug),
            description: extractDocDescription(markdown),
          }
        }),
    )
  }

  async getRendered(
    category: DocCategory,
    slug: string,
    locale: DocLocale,
  ): Promise<RenderedDoc | null> {
    const markdown = await this.getRaw(category, slug, locale)
    if (!markdown) {
      return null
    }

    return {
      slug,
      title: extractDocTitle(markdown, slug),
      description: extractDocDescription(markdown),
      html: await renderMarkdownToHtml(markdown),
    }
  }

  async getRaw(category: DocCategory, slug: string, locale: DocLocale): Promise<string | null> {
    return this.#readMarkdownBySlug(category, slug, locale).catch(() => null)
  }

  async #readMarkdownBySlug(category: DocCategory, slug: string, locale: DocLocale): Promise<string> {
    return readFile(
      resolve(this.#rootForLocale(locale), docCategoryDir(category), `${slug}.md`),
      'utf8',
    )
  }

  #rootForLocale(locale: DocLocale): string {
    const localeDir = docLocaleDir(locale)
    return localeDir ? resolve(this.#docsDir, localeDir) : this.#docsDir
  }
}
