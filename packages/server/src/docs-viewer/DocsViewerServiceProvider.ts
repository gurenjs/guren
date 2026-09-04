import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { ServiceProvider } from '../container/ServiceProvider'
import { createDocsViewerAccessGuard, DOCS_VIEWER_PATH, isDocsViewerEnabled } from './endpoint'

/**
 * The slice of `@guren/cli` the viewer needs, loaded via dynamic import so
 * `@guren/server` takes no static dependency on the CLI.
 */
interface DocsViewerCliApi {
  buildDocsViewerData(cwd: string): Promise<unknown>
  docsViewerAssetPath(): string
}

/**
 * How long a built `data.json` payload answers requests. Longer than the UI's
 * poll interval, so a visible tab does not re-read and re-render every doc
 * inside the dev server every few seconds only to find the ETag unchanged.
 */
const DATA_CACHE_TTL_MS = 15_000

/**
 * The docs viewer (RFC 0005) at /_guren/docs: a read-only, loopback-guarded UI
 * over the OKF docs bundle, mounted only while `isDocsViewerEnabled()` holds.
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

    // Read once: the shell never changes for the lifetime of the process.
    let shell: Promise<string> | null = null
    hono.get(DOCS_VIEWER_PATH, async (ctx) => {
      shell ??= readFile(cli.docsViewerAssetPath(), 'utf-8')
      return ctx.html(await shell)
    })

    // The promise is cached, not the value, so two tabs polling at once
    // await one build instead of each running their own.
    let cached: { at: number; payload: Promise<{ body: string; etag: string }> } | null = null
    const payload = (): Promise<{ body: string; etag: string }> => {
      if (!cached || Date.now() - cached.at > DATA_CACHE_TTL_MS) {
        cached = {
          at: Date.now(),
          payload: cli.buildDocsViewerData(cwd).then((data) => {
            const body = JSON.stringify(data)
            return { body, etag: `"${createHash('sha1').update(body).digest('hex')}"` }
          }),
        }
      }
      return cached.payload
    }

    hono.get(`${DOCS_VIEWER_PATH}/data.json`, async (ctx) => {
      const { body, etag } = await payload()
      if (ctx.req.header('if-none-match') === etag) {
        return ctx.body(null, 304, { ETag: etag })
      }
      return ctx.body(body, 200, { 'Content-Type': 'application/json', ETag: etag })
    })

    // Mermaid is resolved from the *app's* node_modules rather than shipped in
    // a @guren/* package (~1 MB every install would carry for a dev-only
    // screen); absent, the UI degrades diagram fences to code blocks. Read once
    // and served with a validator, since it is identical on every request.
    let mermaid: Promise<Buffer> | null = null
    hono.get(`${DOCS_VIEWER_PATH}/assets/mermaid.js`, async (ctx) => {
      try {
        mermaid ??= readFile(
          createRequire(join(cwd, 'package.json')).resolve('mermaid/dist/mermaid.min.js'),
        )
        const source = await mermaid
        return ctx.body(new Uint8Array(source), 200, {
          'Content-Type': 'text/javascript',
          'Cache-Control': 'max-age=3600',
        })
      } catch {
        mermaid = null
        return ctx.json({ message: 'mermaid is not installed (bun add -d mermaid)' }, 404)
      }
    })
  }
}
