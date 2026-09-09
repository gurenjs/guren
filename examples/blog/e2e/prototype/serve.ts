/**
 * A static file host for the prototype build, behaving like GitHub Pages: a
 * path with no file answers `404.html` with a 404 status, which is the SPA
 * fallback the build relies on when no `_redirects` support exists. Bound to
 * one port and refusing to move, so the URL Playwright addresses is this
 * server or nothing.
 */
import { existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = path.resolve(process.env.PROTOTYPE_DIR ?? fileURLToPath(new URL('../../dist/prototype', import.meta.url)))
const base = normalizeBase(process.env.PROTOTYPE_BASE || '/')
const port = Number(process.env.PORT || 3334)

if (!existsSync(path.join(dir, 'index.html'))) {
  console.error(`No prototype build at ${dir}; run \`bun run build:prototype\` first.`)
  process.exit(1)
}

function normalizeBase(value: string): string {
  const trimmed = value.replace(/^\/*/u, '/').replace(/\/*$/u, '/')
  return trimmed === '//' ? '/' : trimmed
}

function fileFor(pathname: string): string | undefined {
  if (base !== '/' && !pathname.startsWith(base) && pathname !== base.slice(0, -1)) return undefined
  const relative = base === '/' ? pathname : pathname.slice(base.length - 1)
  const target = path.resolve(dir, `.${relative === '' ? '/' : relative}`)
  if (!target.startsWith(dir)) return undefined
  if (existsSync(target) && statSync(target).isFile()) return target
  const index = path.join(target, 'index.html')
  return existsSync(index) ? index : undefined
}

const server = Bun.serve({
  port,
  hostname: '127.0.0.1',
  fetch(request) {
    const { pathname } = new URL(request.url)
    const file = fileFor(decodeURIComponent(pathname))
    if (file) return new Response(Bun.file(file))
    return new Response(Bun.file(path.join(dir, '404.html')), {
      status: 404,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    })
  },
})

console.log(`Prototype static host: http://127.0.0.1:${server.port}${base} <- ${dir}`)
