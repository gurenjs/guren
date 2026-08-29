/**
 * Stage the docs site's static extras into `web/public/`: the screenshots
 * from `docs/images/`, and the mermaid bundle the docs pages load on demand.
 *
 * Docs markdown keeps GitHub-relative image paths (`../../images/foo.png`)
 * so the screenshots render on GitHub; `rewriteDocImage` in
 * app/Services/MarkdownRenderer.ts maps those onto `/docs-images/…`, and the
 * files have to exist under `public/` for both the dev server and the
 * Cloudflare build (which stages all of `public/` into Static Assets).
 *
 * Both copies are generated, so their `public/` destinations are gitignored
 * and rebuilt here rather than committed twice.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { stageMermaid } from './lib/stage-mermaid.js'

const webRoot = fileURLToPath(new URL('..', import.meta.url))
const sourceDir = resolve(webRoot, '../docs/images')
const targetDir = resolve(webRoot, 'public/docs-images')

const mermaid = stageMermaid()
console.log(
  mermaid.copied
    ? `Staged mermaid at public/${mermaid.path.split('/public/')[1]}.`
    : 'Mermaid already staged and current.',
)

if (!existsSync(sourceDir)) {
  // Deleting the last screenshot must not leave the previous ones served
  // locally and bundled into the next deploy.
  rmSync(targetDir, { recursive: true, force: true })
  console.log('No docs/images directory — removed any previously staged copy.')
  process.exit(0)
}

rmSync(targetDir, { recursive: true, force: true })
mkdirSync(targetDir, { recursive: true })
cpSync(sourceDir, targetDir, { recursive: true })

console.log(`Copied ${readdirSync(targetDir).length} docs image(s) into web/public/docs-images/.`)
