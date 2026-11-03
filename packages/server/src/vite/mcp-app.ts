/**
 * `vite build --mode mcp-app` (RFC 0038 §4): one self-contained HTML document
 * per page an `.agent({ ui })` route names, everything inlined, since a host's
 * default CSP allows no origin but its own sandbox. The mode's own build only
 * drives: each page is a nested build of the app's Vite config with one entry
 * and no code splitting, which a single multi-input build cannot give.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

export const MCP_APP_MODE = 'mcp-app'
/** Names the page a nested build makes; unset in the driving build. */
export const MCP_APP_PAGE_ENV = 'GUREN_MCP_APP_PAGE'
/** `rolldown` or `rollup`: which bundler the driver's Vite runs, so a page build disables splitting in its spelling. */
export const MCP_APP_BUNDLER_ENV = 'GUREN_MCP_APP_BUNDLER'
export const MCP_APP_OUT_DIR = '.guren/mcp-app'
export const MCP_APP_MODULE = '.guren/mcp-app/index.gen.ts'
export const MCP_APP_SETUP_FILE = 'resources/js/mcp-app.tsx'
export const MCP_APP_ENTRY_ID = '\0guren-mcp-app-entry'
export const MCP_APP_DRIVER_ID = '\0guren-mcp-app-driver'
const AGENTS_MODULE = '.guren/agents.gen.ts'
const PAGE_EXTENSIONS = ['.tsx', '.jsx', '.ts', '.js']

export interface GurenMcpAppOptions {
  /** The app-owned setup every view mounts with, relative to the root. Defaults to `resources/js/mcp-app.tsx`. */
  entry?: string
}

export interface McpAppBuildContext {
  root: string
  resourcesDir: string
  setupFile: string
}

/** The page ids codegen wrote as `agentUiPages`; none when the app declares no `ui` route. */
export function readAgentUiPages(root: string): string[] {
  let source: string
  try {
    source = readFileSync(path.resolve(root, AGENTS_MODULE), 'utf8')
  } catch {
    return []
  }
  const literal = /export const agentUiPages = (\[[^\]]*\]) as const/u.exec(source)?.[1]
  if (!literal) return []
  const parsed: unknown = JSON.parse(literal)
  return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []
}

/** The page module an id names, by the rule `pages.gen.ts` is written with: `pages/<id>` under the resources directory. */
export function resolvePageFile(context: McpAppBuildContext, id: string): string | undefined {
  const base = path.resolve(context.root, context.resourcesDir, 'pages', id)
  return PAGE_EXTENSIONS.map((extension) => `${base}${extension}`).find((file) => existsSync(file))
}

export function renderSetupTemplate(stylesheet: string | undefined): string {
  return `${stylesheet ? `import '${stylesheet}'\n` : ''}import React from 'react'
import { createRoot } from 'react-dom/client'
import { ErrorBoundary } from '@guren/inertia-client'
import type { StartMcpAppOptions } from '@guren/inertia-client/mcp-app'

// What every MCP App view mounts with (RFC 0038 §4). Owned by the app: keep its
// providers and stylesheet in step with resources/js/app.tsx.
export const setup: StartMcpAppOptions['setup'] = ({ el, App, props }) => {
  createRoot(el).render(
    React.createElement(ErrorBoundary, null,
      React.createElement(App, props as any),
    ),
  )
}
`
}

/** Writes the setup file on the first build; an existing one is the app's and is never touched. */
export function ensureSetupFile(context: McpAppBuildContext): string {
  const file = path.resolve(context.root, context.setupFile)
  if (existsSync(file)) return file
  const css = path.resolve(context.root, context.resourcesDir, '../css/app.css')
  const stylesheet = existsSync(css) ? toImportPath(path.dirname(file), css) : undefined
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, renderSetupTemplate(stylesheet))
  return file
}

export function renderPageEntry(id: string, setupFile: string, pageFile: string): string {
  return `import { startMcpApp } from '@guren/inertia-client/mcp-app'
import * as app from ${JSON.stringify(setupFile)}
import Page from ${JSON.stringify(pageFile)}

const id = ${JSON.stringify(id)}
void startMcpApp({
  ...app,
  resolve: async (name) => {
    if (name === id) return { default: Page }
    throw new Error(\`This view bundles the page "\${id}" only, not "\${name}".\`)
  },
})
`
}

export function renderPageDocument(scripts: readonly string[], styles: readonly string[]): string {
  const style = styles.map((css) => `<style>${css.replaceAll('</style', '<\\/style')}</style>`).join('')
  const script = scripts.map((js) => `<script type="module">${js.replaceAll('</script', '<\\/script')}</script>`).join('')
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${style}</head><body><div id="app"></div>${script}</body></html>`
}

export function contentHash(html: string): string {
  return createHash('sha256').update(html).digest('hex').slice(0, 12)
}

export function pageDocumentFile(root: string, id: string): string {
  return path.resolve(root, MCP_APP_OUT_DIR, 'pages', `${id}.html`)
}

/** `.guren/mcp-app/index.gen.ts`, the shape `mcpPlugin({ ui: { pages } })` imports. */
export function renderPagesModule(pages: Readonly<Record<string, { html: string; hash: string }>>): string {
  const entries = Object.entries(pages)
    .map(([id, page]) => `  ${JSON.stringify(id)}: { html: ${JSON.stringify(page.html)}, hash: ${JSON.stringify(page.hash)} },`)
    .join('\n')
  return `// Generated by \`vite build --mode mcp-app\` — DO NOT EDIT.
export const mcpAppPages: Record<string, { html: string; hash: string }> = {
${entries}
}
`
}

/** A page build's output, as the nested build's `generateBundle` sees it. */
export interface BundleItem {
  type: 'chunk' | 'asset'
  fileName: string
  code?: string
  source?: string | Uint8Array
  isEntry?: boolean
}

/** One page's document from its bundle, and the files it could not inline. */
export function documentFromBundle(items: readonly BundleItem[]): { html: string; leftovers: string[] } {
  const scripts = items.filter((item) => item.type === 'chunk' && item.isEntry).map((item) => item.code ?? '')
  const styles = items
    .filter((item) => item.type === 'asset' && item.fileName.endsWith('.css'))
    .map((item) => (typeof item.source === 'string' ? item.source : new TextDecoder().decode(item.source)))
  const leftovers = items
    .filter((item) => !(item.type === 'chunk' && item.isEntry) && !(item.type === 'asset' && item.fileName.endsWith('.css')))
    .map((item) => item.fileName)
  return { html: renderPageDocument(scripts, styles), leftovers }
}

export interface RunMcpAppBuildOptions {
  context: McpAppBuildContext
  /** Builds one page; the nested build writes its document to `pageDocumentFile()`. */
  buildPage(id: string): Promise<void>
  log?(message: string): void
}

/** The driving build: every page in turn, then the module the plugin imports. */
export async function runMcpAppBuild(options: RunMcpAppBuildOptions): Promise<Record<string, { html: string; hash: string }>> {
  const { context } = options
  const ids = readAgentUiPages(context.root)
  rmSync(path.resolve(context.root, MCP_APP_OUT_DIR, 'pages'), { recursive: true, force: true })
  const pages: Record<string, { html: string; hash: string }> = {}

  if (ids.length > 0) {
    assertExtAppsInstalled(context.root)
    ensureSetupFile(context)
    for (const id of ids) {
      if (!resolvePageFile(context, id)) {
        throw new Error(`The page "${id}" an .agent({ ui }) route names has no file under ${context.resourcesDir}/pages/.`)
      }
      await options.buildPage(id)
      const html = readFileSync(pageDocumentFile(context.root, id), 'utf8')
      pages[id] = { html, hash: contentHash(html) }
      options.log?.(`mcp-app: ${id} (${(html.length / 1024).toFixed(1)} KB)`)
    }
  } else {
    options.log?.('mcp-app: no .agent({ ui }) route in .guren/agents.gen.ts; run `guren codegen` after adding one.')
  }

  const module = path.resolve(context.root, MCP_APP_MODULE)
  mkdirSync(path.dirname(module), { recursive: true })
  writeFileSync(module, renderPagesModule(pages))
  return pages
}

function assertExtAppsInstalled(root: string): void {
  try {
    createRequire(path.resolve(root, 'package.json')).resolve('@modelcontextprotocol/ext-apps')
  } catch {
    throw new Error('MCP App views need @modelcontextprotocol/ext-apps: run `bun add @modelcontextprotocol/ext-apps`.')
  }
}

function toImportPath(fromDir: string, file: string): string {
  const relative = path.relative(fromDir, file).split(path.sep).join('/')
  return relative.startsWith('.') ? relative : `./${relative}`
}
