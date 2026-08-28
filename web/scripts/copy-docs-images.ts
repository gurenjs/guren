/**
 * Mirror `docs/images/` into `web/public/docs-images/`.
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
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const webRoot = fileURLToPath(new URL('..', import.meta.url))
const sourceDir = resolve(webRoot, '../docs/images')
const targetDir = resolve(webRoot, 'public/docs-images')

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
