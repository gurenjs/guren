// Writes the docs viewer's shell with `src/docs-viewer-page/main.ts` bundled into it. The
// package's `build` script runs it, and `files` ships the directory it writes to.

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { composeDocsViewerPage, DOCS_VIEWER_ASSET_DIR } from '../src/docs-viewer-shell'

const packageRoot = join(import.meta.dir, '..')
const html = composeDocsViewerPage(join(packageRoot, 'src/docs-viewer-page'))

mkdirSync(join(packageRoot, DOCS_VIEWER_ASSET_DIR), { recursive: true })
writeFileSync(join(packageRoot, DOCS_VIEWER_ASSET_DIR, 'index.html'), html)
console.log(`[docs-viewer] wrote ${DOCS_VIEWER_ASSET_DIR}/index.html (${Math.round(html.length / 1024)} KiB)`)
