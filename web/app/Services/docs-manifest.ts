// Where the prerendered docs live once they leave the worker bundle. The
// manifest (titles, descriptions) is the only docs data the Worker bundles;
// the rendered HTML, the markdown source and llms-full.txt are files under
// public/, served by Workers Static Assets and read back through the ASSETS
// binding. Every path here is therefore also a public URL, and
// `public/_headers` names the same prefixes (tests/services/docs-headers.test.ts).
import { docPaths, type DocLocale } from '../../config/site.js'

export interface DocManifestEntry {
  title: string
  description?: string
}

/** Locale, then category, then slug. */
export type DocsManifestIndex = Record<string, Record<string, Record<string, DocManifestEntry>>>

export interface DocsManifest {
  prerendered: boolean
  docs: DocsManifestIndex
}

/** One `public/_docs/**.json` file: self-describing, so a direct fetch needs no manifest. */
export interface DocFragment extends DocManifestEntry {
  html: string
}

export const DOC_FRAGMENT_ROOT = '/_docs'

export const LLMS_FULL_PATH = '/llms-full.txt'

/** Title and description only, the latter absent rather than `undefined` so JSON round-trips equal. */
export function manifestEntry(doc: DocManifestEntry): DocManifestEntry {
  return {
    title: doc.title,
    ...(doc.description !== undefined ? { description: doc.description } : {}),
  }
}

export function docFragmentPath(locale: string, category: string, slug: string): string {
  return `${DOC_FRAGMENT_ROOT}/${locale}/${category}/${slug}.json`
}

/** The same URL the `.md` route serves, so the static file answers first on Workers. */
export function docMarkdownPath(locale: DocLocale, category: string, slug: string): string {
  return `${docPaths(category, slug)[locale]}.md`
}
