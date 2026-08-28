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
 * The copy is the generated half of that pair, so `public/docs-images/` is
 * gitignored and rebuilt here rather than committed twice.
 */
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const webRoot = fileURLToPath(new URL('..', import.meta.url))
const sourceDir = resolve(webRoot, '../docs/images')
const targetDir = resolve(webRoot, 'public/docs-images')
const mermaidTarget = resolve(webRoot, 'public/docs-assets/mermaid.js')

/**
 * Docs pages render ```mermaid fences client-side (pages/Docs/Show.tsx).
 * The library is staged as a plain script rather than imported, because it
 * cannot fit the repo's 600 kB per-asset build budget in any split. The
 * destination is deliberately *not* `public/assets/`, which is the budgeted
 * client-bundle output that `scripts/smoke/build-budget.ts` scans. Keep the
 * path in step with MERMAID_SCRIPT_SRC in Show.tsx.
 */
function stageMermaid(): void {
  const entry = createRequire(import.meta.url).resolve('mermaid/dist/mermaid.min.js')
  mkdirSync(dirname(mermaidTarget), { recursive: true })
  copyFileSync(entry, mermaidTarget)
  const megabytes = (statSync(mermaidTarget).size / 1024 / 1024).toFixed(1)
  console.log(`Staged mermaid (${megabytes} MB) at public/docs-assets/mermaid.js.`)
}

stageMermaid()

if (!existsSync(sourceDir)) {
  // No pictures in the docs tree yet — leave any stale copy alone rather
  // than deleting a directory this script did not create.
  console.log('No docs/images directory — skipping docs image copy.')
  process.exit(0)
}

rmSync(targetDir, { recursive: true, force: true })
mkdirSync(targetDir, { recursive: true })
cpSync(sourceDir, targetDir, { recursive: true })

console.log(`Copied ${readdirSync(targetDir).length} docs image(s) into web/public/docs-images/.`)
