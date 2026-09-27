/**
 * The docs viewer's page (RFC 0005): `docs-viewer-page/` bundled into its template. A leaf, so
 * the build script that writes the shell loads none of the payload's readers.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { composePage } from './page-bundle'

/** Where the build writes the composed shell, relative to the package root; `files` ships it. */
export const DOCS_VIEWER_ASSET_DIR = 'assets/docs-viewer'
const DOCS_VIEWER_PAGE = { template: 'index.html', entry: 'main.ts', placeholder: '__GUREN_DOCS_VIEWER_SCRIPT__', what: 'docs viewer' }

/** The template under `pageDir` (`src/docs-viewer-page/`) with its TypeScript bundled in: what the build writes. */
export function composeDocsViewerPage(pageDir: string): string {
  return composePage(pageDir, DOCS_VIEWER_PAGE)
}

/**
 * Absolute path of the shell the build composed. `assets/` sits next to both `src/` and `dist/`,
 * so the relative hop works from source and build alike; from source, prefer {@link docsViewerShell}.
 */
export function docsViewerAssetPath(): string {
  return fileURLToPath(new URL(`../${DOCS_VIEWER_ASSET_DIR}/index.html`, import.meta.url))
}

let shell: string | undefined

/**
 * The viewer's HTML. Run from source, `docs-viewer-page/` sits beside this module and is composed
 * once per process, so nothing reads a build gone stale; the published package ships only the
 * composed file, which is read instead.
 */
export function docsViewerShell(): string {
  if (shell !== undefined) return shell
  try {
    shell = composeDocsViewerPage(fileURLToPath(new URL('./docs-viewer-page/', import.meta.url)))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    shell = readFileSync(docsViewerAssetPath(), 'utf8')
  }
  return shell
}
