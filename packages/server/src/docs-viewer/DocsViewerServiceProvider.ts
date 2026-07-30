import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { ServiceProvider } from '../container/ServiceProvider'
import { createDocsViewerAccessGuard, DOCS_VIEWER_PATH, isDocsViewerEnabled } from './endpoint'

/**
 * The slice of `@guren/cli` the viewer needs, loaded via dynamic import
 * (same pattern as `McpServiceProvider`) so `@guren/server` takes no
 * static dependency on the CLI and production bundles stay clean.
 */
interface DocsViewerCliApi {
  buildDocsViewerData(cwd: string): Promise<unknown>
  docsViewerAssetPath(): string
}

/**
 * How long a built `data.json` payload answers subsequent requests. The
 * UI polls every few seconds for freshness; this absorbs those polls
 * without re-scanning the project on each one.
 */
const DATA_CACHE_TTL_MS = 2000

/**
 * Registers the docs viewer (RFC 0005) at /_guren/docs: a read-only,
 * loopback-guarded UI that renders the OKF docs bundle as an
 * interactive relation graph. Only active while `isDocsViewerEnabled()`
 * holds. All routes are GET; the whole bundle ships as one payload, so
 * no route takes a path parameter.
 */
export class DocsViewerServiceProvider extends ServiceProvider {
  register(): void {
    // Nothing to register in the container
  }

  async boot(): Promise<void> {
    if (!isDocsViewerEnabled()) {
      return
    }

    const app = this.container.make<{ hono: import('hono').Hono }>('app')
    const hono = app.hono
    const cwd = process.cwd()

    // @ts-ignore — @guren/cli is available at runtime via the app's dependencies
    const cli = (await import('@guren/cli')) as DocsViewerCliApi

    const guard = createDocsViewerAccessGuard()
    hono.use(DOCS_VIEWER_PATH, guard)
    hono.use(`${DOCS_VIEWER_PATH}/*`, guard)

    hono.get(DOCS_VIEWER_PATH, async (ctx) => {
      const html = await readFile(cli.docsViewerAssetPath(), 'utf-8')
      return ctx.html(html)
    })

    let cached: { at: number; body: string; etag: string } | null = null
    hono.get(`${DOCS_VIEWER_PATH}/data.json`, async (ctx) => {
      if (!cached || Date.now() - cached.at > DATA_CACHE_TTL_MS) {
        const body = JSON.stringify(await cli.buildDocsViewerData(cwd))
        const etag = `"${createHash('sha1').update(body).digest('hex')}"`
        cached = { at: Date.now(), body, etag }
      }

      if (ctx.req.header('if-none-match') === cached.etag) {
        return ctx.body(null, 304, { ETag: cached.etag })
      }
      return ctx.body(cached.body, 200, {
        'Content-Type': 'application/json',
        ETag: cached.etag,
      })
    })

    // Mermaid is resolved from the *app's* node_modules rather than
    // shipped in a @guren/* package (~1 MB that every install would
    // otherwise carry for a dev-only screen). Absent, the UI degrades
    // diagram fences to plain code blocks with an install hint.
    hono.get(`${DOCS_VIEWER_PATH}/assets/mermaid.js`, async (ctx) => {
      try {
        const require = createRequire(join(cwd, 'package.json'))
        const source = await readFile(require.resolve('mermaid/dist/mermaid.min.js'), 'utf-8')
        return ctx.body(source, 200, { 'Content-Type': 'text/javascript' })
      } catch {
        return ctx.json({ message: 'mermaid is not installed (bun add -d mermaid)' }, 404)
      }
    })
  }
}
