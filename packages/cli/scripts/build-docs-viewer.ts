// Writes each browser page's shell with its `main.ts` bundled in. The package's `build` script
// runs it, and `files` ships the directory each page is written to.

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { composeDevCenterPage, DEV_CENTER_ASSET_DIR } from '../src/dev-center-shell'
import { composeDocsViewerPage, DOCS_VIEWER_ASSET_DIR } from '../src/docs-viewer-shell'

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
