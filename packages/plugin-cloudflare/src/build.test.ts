import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildCloudflareOutput } from './build'

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2))
}

function scaffoldApp(root: string, options: { ssr?: boolean; renderExport?: string } = {}): void {
  const { ssr = true, renderExport = 'export const render = () => ({ body: "", head: [] })' } = options

  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src/app.ts'), 'export default { boot: async () => {}, fetch: async () => new Response("ok") }\n')
  writeJson(join(root, 'package.json'), { name: '@acme/demo-app' })

  mkdirSync(join(root, 'public/assets/.vite'), { recursive: true })
  writeFileSync(join(root, 'public/robots.txt'), 'User-agent: *\n')
  writeFileSync(join(root, 'public/assets/app-Abc123.js'), 'console.log("client")\n')
  writeJson(join(root, 'public/assets/.vite/manifest.json'), {
    'resources/js/app.tsx': { file: 'app-Abc123.js', css: ['app-Def456.css'] },
  })

  if (ssr) {
    mkdirSync(join(root, '.guren/ssr/.vite'), { recursive: true })
    writeFileSync(join(root, '.guren/ssr/ssr-Xyz789.js'), `${renderExport}\n`)
    writeJson(join(root, '.guren/ssr/.vite/manifest.json'), {
      'resources/js/ssr.tsx': { file: 'ssr-Xyz789.js' },
    })
  }
}

describe('buildCloudflareOutput', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'guren-cf-build-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  test('should generate a worker that wires SSR, assets env, and the app entry', async () => {
    scaffoldApp(root)

    await buildCloudflareOutput({ rootDir: root, skipAppBuild: true })

    const worker = readFileSync(join(root, '.cloudflare/worker.js'), 'utf8')
    expect(worker).toContain("import { createWorkersHandler } from '@guren/plugin-cloudflare'")
    expect(worker).toContain("import { setInertiaSsrRenderer } from '@guren/core'")
    expect(worker).toContain('import * as ssrModule from "../.guren/ssr/ssr-Xyz789.js"')
    expect(worker).toContain('import app from "../src/app.ts"')
    expect(worker).toContain('process.env.GUREN_INERTIA_ENTRY = "/assets/app-Abc123.js"')
    expect(worker).toContain('process.env.GUREN_INERTIA_STYLES = "/assets/app-Def456.css"')
    expect(worker).toContain('setInertiaSsrRenderer(ssrModule.render ?? ssrModule.default)')
    expect(worker).toContain('export default createWorkersHandler(app)')
  })

  test('should copy public files into the assets directory', async () => {
    scaffoldApp(root)

    await buildCloudflareOutput({ rootDir: root, skipAppBuild: true })

    expect(readFileSync(join(root, '.cloudflare/assets/robots.txt'), 'utf8')).toContain('User-agent')
    expect(existsSync(join(root, '.cloudflare/assets/assets/app-Abc123.js'))).toBe(true)
  })

  test('should mirror built assets under the /public/assets base URL path', async () => {
    scaffoldApp(root)

    await buildCloudflareOutput({ rootDir: root, skipAppBuild: true })

    expect(existsSync(join(root, '.cloudflare/assets/public/assets/app-Abc123.js'))).toBe(true)
  })

  test('should reject an SSR manifest entry that escapes the SSR directory', async () => {
    scaffoldApp(root)
    writeJson(join(root, '.guren/ssr/.vite/manifest.json'), {
      'resources/js/ssr.tsx': { file: '../../outside.js' },
    })

    await expect(buildCloudflareOutput({ rootDir: root, skipAppBuild: true })).rejects.toThrow(
      /escapes the SSR output directory/,
    )
  })

  test('should refuse an outputDir that is or contains the app root', async () => {
    scaffoldApp(root)

    await expect(
      buildCloudflareOutput({ rootDir: root, outputDir: root, skipAppBuild: true }),
    ).rejects.toThrow(/never the root itself/)
    await expect(
      buildCloudflareOutput({ rootDir: root, outputDir: join(root, '..'), skipAppBuild: true }),
    ).rejects.toThrow(/never the root itself/)
    expect(existsSync(join(root, 'src/app.ts'))).toBe(true)
  })

  test('should scaffold wrangler.jsonc once and never overwrite it', async () => {
    scaffoldApp(root)

    await buildCloudflareOutput({ rootDir: root, skipAppBuild: true })

    const configPath = join(root, 'wrangler.jsonc')
    const config = JSON.parse(readFileSync(configPath, 'utf8'))
    expect(config.name).toBe('demo-app')
    expect(config.main).toBe('.cloudflare/worker.js')
    expect(config.compatibility_flags).toEqual(['nodejs_compat'])
    expect(config.assets.directory).toBe('.cloudflare/assets')
    expect(config.d1_databases[0].migrations_dir).toBe('db/migrations')

    writeFileSync(configPath, '{ "name": "user-edited" }\n')
    await buildCloudflareOutput({ rootDir: root, skipAppBuild: true })
    expect(readFileSync(configPath, 'utf8')).toContain('user-edited')
  })

  test('should generate a CSR-only worker when no SSR manifest exists', async () => {
    scaffoldApp(root, { ssr: false })

    await buildCloudflareOutput({ rootDir: root, skipAppBuild: true })

    const worker = readFileSync(join(root, '.cloudflare/worker.js'), 'utf8')
    expect(worker).not.toContain('setInertiaSsrRenderer')
    expect(worker).toContain('export default createWorkersHandler(app)')
  })

  test('should accept an SSR entry with a default export', async () => {
    scaffoldApp(root, { renderExport: 'export default () => ({ body: "", head: [] })' })

    await buildCloudflareOutput({ rootDir: root, skipAppBuild: true })

    const worker = readFileSync(join(root, '.cloudflare/worker.js'), 'utf8')
    expect(worker).toContain('setInertiaSsrRenderer(ssrModule.render ?? ssrModule.default)')
  })

  test('should throw when the SSR entry exports no renderer', async () => {
    scaffoldApp(root, { renderExport: 'export const unrelated = 42' })

    await expect(buildCloudflareOutput({ rootDir: root, skipAppBuild: true })).rejects.toThrow(
      /does not export a renderer/,
    )
  })

  test('should throw when the app entry is missing', async () => {
    scaffoldApp(root)
    rmSync(join(root, 'src/app.ts'))

    await expect(buildCloudflareOutput({ rootDir: root, skipAppBuild: true })).rejects.toThrow(
      /app entry not found/,
    )
  })
})
