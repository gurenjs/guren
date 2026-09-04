/**
 * Publish a static snapshot of the docs viewer (RFC 0005) under
 * web/public/_guren/docs/. Usage: bun scripts/prerender-docs-viewer.ts
 *
 * The viewer never runs here: `DocsViewerServiceProvider` reads the bundle off
 * disk through @guren/cli per request, but this app deploys to Workers — no
 * filesystem, and wrangler.jsonc aliases @guren/cli to a stub. So the payload
 * and the shipped shell are emitted once as plain static assets.
 *
 * `isDocsViewerEnabled()` is deliberately untouched and still refuses to mount
 * in production; what this publishes is the blog example's public docs.
 */
import { mkdirSync, statSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { buildDocsViewerData, docsViewerAssetPath } from '@guren/cli'

import { stageMermaid } from './lib/stage-mermaid.js'

const webRoot = fileURLToPath(new URL('..', import.meta.url))

/**
 * The framework's own docs/ carries no OKF relations (109 documents, zero
 * edges), so the blog example is the only bundle with a graph to show.
 */
const bundleRoot = resolve(webRoot, '../examples/blog')
const outDir = resolve(webRoot, 'public/_guren/docs')

/** Injected once each; every replacement is asserted, so a reshaped shell fails the build. */
const BANNER = `
<style>
.demo-banner {
  position: fixed; top: 1.5rem; right: 1.75rem; z-index: 5;
  max-width: 22rem; text-align: right;
  font-family: var(--mono); font-size: 0.72rem; line-height: 1.6;
  color: var(--text-muted);
}
.demo-banner code { color: var(--text-secondary); }
.demo-banner a { color: var(--accent); text-decoration: none; }
.demo-banner a:hover { text-decoration: underline; }
@media (max-width: 900px) { .demo-banner { display: none; } }
</style>
<meta name="robots" content="noindex" />
`

const BANNER_BODY = `
<p class="demo-banner">
  A static snapshot of the blog example's docs. In your own app the viewer
  runs on your machine: <code>GUREN_DOCS=1 bun run dev</code>, then
  <code>/_guren/docs</code>.
  <a href="https://guren.dev/docs/guides/spec-anchored">how this works ↗</a>
</p>
`

function inject(html: string, anchor: string, replacement: string): string {
  const occurrences = html.split(anchor).length - 1
  if (occurrences !== 1) {
    throw new Error(
      `docs viewer shell: expected exactly one ${JSON.stringify(anchor)}, found ${occurrences}. ` +
        'The shipped asset changed shape — update this script rather than the asset.',
    )
  }
  return html.replace(anchor, replacement)
}

function write(path: string, content: string): void {
  writeFileSync(path, content, 'utf8')
  report(path)
}

function report(path: string): void {
  const bytes = statSync(path).size
  console.log(`  ${path.replace(webRoot, 'web/')} — ${formatBytes(bytes)}`)
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

const data = await buildDocsViewerData(bundleRoot)

// A bundle resolved to the wrong directory still builds, just empty — which is
// indistinguishable from a working one that renders nothing.
if (data.nodes.length === 0 || data.edges.length === 0) {
  console.error(
    `No docs graph at ${bundleRoot} (${data.nodes.length} nodes, ${data.edges.length} edges). ` +
      'Nothing worth publishing — refusing to write an empty viewer.',
  )
  process.exit(1)
}

mkdirSync(resolve(outDir, 'assets'), { recursive: true })

const json = JSON.stringify(data)
write(resolve(outDir, 'data.json'), json)
console.log(
  `    ${data.nodes.length} nodes, ${data.edges.length} edges, ${data.docs.length} docs` +
    ` — ${formatBytes(gzipSync(Buffer.from(json, 'utf8')).length)} gzipped`,
)

const shell = await readFile(docsViewerAssetPath(), 'utf-8')
write(
  resolve(outDir, 'index.html'),
  inject(
    inject(
      inject(shell, '<title>Guren docs</title>', '<title>Guren docs graph — blog example</title>'),
      '</head>',
      `${BANNER}</head>`,
    ),
    '<body>',
    `<body>${BANNER_BODY}`,
  ),
)

// The shell loads mermaid from a fixed path and degrades to "bun add -d
// mermaid" hints without it; three of the example's spec views are diagrams.
report(stageMermaid().path)
