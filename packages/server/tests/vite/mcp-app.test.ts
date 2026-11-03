import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  documentFromBundle,
  ensureSetupFile,
  MCP_APP_DRIVER_ID,
  MCP_APP_ENTRY_ID,
  MCP_APP_MODULE,
  MCP_APP_PAGE_ENV,
  pageDocumentFile,
  readAgentUiPages,
  renderPageDocument,
  renderPagesModule,
  runMcpAppBuild,
} from '../../src/vite/mcp-app'
import { gurenVitePlugin } from '../../src/vite/plugin'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  delete process.env[MCP_APP_PAGE_ENV]
})

function app(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'guren-mcp-app-'))
  roots.push(root)
  for (const [file, contents] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    writeFileSync(path.join(root, file), contents)
  }
  return root
}

const AGENTS = 'export const agentTools = []\n\nexport const agentUiPages = ["posts/Show"] as const\n'
const context = (root: string) => ({ root, resourcesDir: 'resources/js', setupFile: 'resources/js/mcp-app.tsx' })

describe('readAgentUiPages', () => {
  it('reads the pages codegen wrote, and none without the manifest', () => {
    expect(readAgentUiPages(app({ '.guren/agents.gen.ts': AGENTS }))).toEqual(['posts/Show'])
    expect(readAgentUiPages(app({}))).toEqual([])
  })

  it('reads a page id holding a bracket and refuses a declaration it cannot read', () => {
    const bracketed = 'export const agentUiPages = ["Show","posts/[id]"] as const\n'
    expect(readAgentUiPages(app({ '.guren/agents.gen.ts': bracketed }))).toEqual(['Show', 'posts/[id]'])
    const broken = 'export const agentUiPages = [\n  "Show",\n] as const\n'
    expect(() => readAgentUiPages(app({ '.guren/agents.gen.ts': broken }))).toThrow('cannot read agentUiPages')
  })
})

describe('renderPageDocument', () => {
  it('inlines scripts and styles so a closing tag in either cannot end the element early', () => {
    const html = renderPageDocument(['const a = "</script>"'], ['a::after { content: "</style>" }'])
    expect(html).toContain('<style>a::after { content: "<\\/style>" }</style>')
    expect(html).toContain('<script type="module">const a = "<\\/script>"</script>')
    expect(html).toContain('<div id="app"></div>')
  })
})

describe('documentFromBundle', () => {
  it('takes the entry chunk and the stylesheet and names everything else', () => {
    const { html, leftovers } = documentFromBundle([
      { type: 'chunk', fileName: 'entry.js', code: 'run()', isEntry: true },
      { type: 'asset', fileName: 'style.css', source: new TextEncoder().encode('body{}') },
      { type: 'asset', fileName: 'font.woff2', source: '' },
    ])
    expect(html).toContain('<style>body{}</style>')
    expect(html).toContain('run()')
    expect(leftovers).toEqual(['font.woff2'])
  })
})

describe('ensureSetupFile', () => {
  it('writes the setup with the app stylesheet once and keeps an edited one', () => {
    const root = app({ 'resources/css/app.css': '' })
    const file = ensureSetupFile(context(root))
    expect(readFileSync(file, 'utf8')).toStartWith("import '../css/app.css'\n")
    writeFileSync(file, 'export const setup = undefined\n')
    ensureSetupFile(context(root))
    expect(readFileSync(file, 'utf8')).toBe('export const setup = undefined\n')
  })
})

describe('runMcpAppBuild', () => {
  it('builds each page in turn and writes the module the plugin imports', async () => {
    const root = app({ '.guren/agents.gen.ts': AGENTS, 'resources/js/pages/posts/Show.tsx': 'export default () => null' })
    mkdirSync(path.join(root, 'node_modules/@modelcontextprotocol/ext-apps'), { recursive: true })
    writeFileSync(path.join(root, 'node_modules/@modelcontextprotocol/ext-apps/package.json'), '{"name":"@modelcontextprotocol/ext-apps","main":"index.js"}')
    writeFileSync(path.join(root, 'node_modules/@modelcontextprotocol/ext-apps/index.js'), '')
    const built: string[] = []

    const pages = await runMcpAppBuild({
      context: context(root),
      buildPage: async (id) => {
        built.push(id)
        mkdirSync(path.dirname(pageDocumentFile(root, id)), { recursive: true })
        writeFileSync(pageDocumentFile(root, id), '<!DOCTYPE html>')
      },
    })

    expect(built).toEqual(['posts/Show'])
    expect(pages['posts/Show']?.hash).toHaveLength(12)
    expect(existsSync(path.join(root, 'resources/js/mcp-app.tsx'))).toBe(true)
    expect(readFileSync(path.join(root, MCP_APP_MODULE), 'utf8')).toBe(renderPagesModule(pages))
  })

  it('fails on an app without ext-apps, naming the install', async () => {
    const root = app({ '.guren/agents.gen.ts': AGENTS })
    await expect(runMcpAppBuild({ context: context(root), buildPage: async () => {} })).rejects.toThrow('bun add @modelcontextprotocol/ext-apps')
  })

  it('writes an empty module for an app with no ui route', async () => {
    const root = app({})
    expect(await runMcpAppBuild({ context: context(root), buildPage: async () => {} })).toEqual({})
    expect(readFileSync(path.join(root, MCP_APP_MODULE), 'utf8')).toContain('mcpAppPages')
  })
})

describe('gurenVitePlugin in mcp-app mode', () => {
  it('drives with an empty entry and writes nothing itself', () => {
    const root = app({})
    const plugin = gurenVitePlugin()
    const config: Record<string, any> = { root }
    plugin.config(config, { command: 'build', mode: 'mcp-app' })
    expect(config.build).toMatchObject({ write: false, copyPublicDir: false, rollupOptions: { input: MCP_APP_DRIVER_ID } })
    expect(plugin.resolveId(MCP_APP_DRIVER_ID)).toBe(MCP_APP_DRIVER_ID)
  })

  it('builds one page as one entry with nothing split out', () => {
    const root = app({ 'resources/js/pages/posts/Show.tsx': 'export default () => null' })
    process.env[MCP_APP_PAGE_ENV] = 'posts/Show'
    const plugin = gurenVitePlugin()
    const config: Record<string, any> = { root }
    plugin.config(config, { command: 'build', mode: 'mcp-app' })

    expect(config.build).toMatchObject({ write: false, cssCodeSplit: false, modulePreload: false, rollupOptions: { input: MCP_APP_ENTRY_ID } })
    expect(config.build.rollupOptions.output.format).toBe('es')
    expect(config.build.assetsInlineLimit()).toBe(true)
    const entry = String(plugin.load(MCP_APP_ENTRY_ID))
    expect(entry).toContain("from '@guren/inertia-client/mcp-app'")
    expect(entry).toContain(JSON.stringify(path.join(root, 'resources/js/pages/posts/Show.tsx')))
  })

  it('leaves the ordinary build alone', () => {
    const plugin = gurenVitePlugin()
    const config: Record<string, any> = { root: app({}) }
    plugin.config(config, { command: 'build', mode: 'production' })
    expect(plugin.resolveId(MCP_APP_ENTRY_ID)).toBeNull()
    expect(config.build.rollupOptions?.input).not.toBe(MCP_APP_ENTRY_ID)
  })
})
