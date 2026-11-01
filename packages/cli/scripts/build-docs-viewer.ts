// Writes each browser page's shell with its `main.ts` bundled in, and the component catalog's client module. The
// package's `build` script runs it, and `files` ships the directories they are written to.

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { composeDevCenterPage, DEV_CENTER_ASSET_DIR } from '../src/dev-center-shell'
import { composeDocsViewerPage, DOCS_VIEWER_ASSET_DIR } from '../src/docs-viewer-shell'
import { bundleUiCatalogClient, UI_CATALOG_ASSET } from '../src/ui-catalog'

const packageRoot = join(import.meta.dir, '..')
const pages = [
  { name: 'docs-viewer', assetDir: DOCS_VIEWER_ASSET_DIR, compose: composeDocsViewerPage, source: 'src/docs-viewer-page' },
  { name: 'dev-center', assetDir: DEV_CENTER_ASSET_DIR, compose: composeDevCenterPage, source: 'src/dev-center-page' },
]

for (const page of pages) {
  const html = page.compose(join(packageRoot, page.source))
  mkdirSync(join(packageRoot, page.assetDir), { recursive: true })
  writeFileSync(join(packageRoot, page.assetDir, 'index.html'), html)
  console.log(`[${page.name}] wrote ${page.assetDir}/index.html (${Math.round(html.length / 1024)} KiB)`)
}

// Not a page of its own: the module the app's Vite serves as the catalog's client (`vite/ui-catalog.ts`).
const catalog = bundleUiCatalogClient(join(packageRoot, 'src/ui-catalog-page'))
mkdirSync(join(packageRoot, dirname(UI_CATALOG_ASSET)), { recursive: true })
writeFileSync(join(packageRoot, UI_CATALOG_ASSET), catalog)
console.log(`[ui-catalog] wrote ${UI_CATALOG_ASSET} (${Math.round(catalog.length / 1024)} KiB)`)
