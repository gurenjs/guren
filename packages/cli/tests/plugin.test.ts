import { beforeEach, afterEach, describe, expect, it } from 'bun:test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createTempWorkspace, type TempWorkspace } from './helpers'
import { installPlugin } from '../src/plugin'

describe('installPlugin', () => {
  let workspace: TempWorkspace

  beforeEach(async () => {
    workspace = await createTempWorkspace('guren-cli-plugin-')
    await mkdir('src', { recursive: true })
    await mkdir('resources/js', { recursive: true })
    await writeFile('src/app.ts', `import { createApp } from '@guren/core'

const app = createApp({
  routes: () => {},
  providers: [],
})

export default app
`)
    await writeFile('package.json', JSON.stringify({
      name: 'plugin-test-app',
      type: 'module',
      scripts: {
        build: 'bun run codegen && bunx vite build && bunx vite build --ssr',
      },
      dependencies: {
        '@guren/core': '^0.2.0-alpha.7',
      },
    }, null, 2))
    await writeFile('resources/js/ssr.tsx', 'export default function render() { return null }\n')
    await writeFile('.gitignore', 'node_modules\n')
  })

  afterEach(async () => {
    await workspace.cleanup()
  })

  it('registers provider import and provider entry', async () => {
    const updated = await installPlugin({ packageName: '@acme/guren-plugin-audit' })

    expect(updated).toContain('src/app.ts')
    expect(updated).toContain('Run: bun add @acme/guren-plugin-audit')

    const app = await readFile('src/app.ts', 'utf8')
    expect(app).toContain("import { AcmeGurenPluginAuditProvider } from '@acme/guren-plugin-audit'")
    expect(app).toContain('providers: [AcmeGurenPluginAuditProvider]')
  })

  it('is idempotent when plugin provider already exists', async () => {
    await installPlugin({ packageName: '@acme/guren-plugin-audit' })
    const second = await installPlugin({ packageName: '@acme/guren-plugin-audit' })

    expect(second).toContain('src/app.ts (already registered)')

    const app = await readFile('src/app.ts', 'utf8')
    const occurrences = app.match(/AcmeGurenPluginAuditProvider/g)?.length ?? 0
    expect(occurrences).toBe(2) // one import + one providers array entry
  })

  it('does not suggest installation if dependency already exists', async () => {
    await writeFile('package.json', JSON.stringify({
      name: 'plugin-test-app',
      type: 'module',
      dependencies: {
        '@guren/core': '^0.2.0-alpha.7',
        '@acme/guren-plugin-audit': '^1.0.0',
      },
    }, null, 2))

    const result = await installPlugin({ packageName: '@acme/guren-plugin-audit' })
    expect(result.some(item => item.startsWith('Run: bun add'))).toBe(false)
  })

  it('scaffolds official Vercel plugin files for SSR apps', async () => {
    const result = await installPlugin({ packageName: '@guren/plugin-vercel' })

    expect(result).toContain('src/app.ts')
    expect(result).toContain('package.json')
    expect(result).toContain('.gitignore')
    expect(result).toContain('src/vercel.ts')
    expect(result).toContain('scripts/vercel-build.ts')
    expect(result).toContain('vercel.json')
    expect(result).toContain('Run: bun add @guren/plugin-vercel')

    const app = await readFile('src/app.ts', 'utf8')
    expect(app).toContain("import { GurenPluginVercelProvider } from '@guren/plugin-vercel'")
    expect(app).toContain('providers: [GurenPluginVercelProvider]')

    const packageJson = JSON.parse(await readFile('package.json', 'utf8')) as { scripts?: Record<string, string> }
    expect(packageJson.scripts?.['vercel:build']).toBe('bun scripts/vercel-build.ts')

    expect(await readFile('.gitignore', 'utf8')).toContain('.vercel')
    expect(await readFile('src/vercel.ts', 'utf8')).toContain("from '@guren/plugin-vercel'")
    expect(await readFile('scripts/vercel-build.ts', 'utf8')).toContain('buildVercelOutput')
    expect(await readFile('vercel.json', 'utf8')).toContain('"outputDirectory": ".vercel/output"')
  })

  it('is idempotent for the official Vercel plugin', async () => {
    await installPlugin({ packageName: '@guren/plugin-vercel' })
    const second = await installPlugin({ packageName: '@guren/plugin-vercel' })

    expect(second).toContain('src/app.ts (already registered)')

    const app = await readFile('src/app.ts', 'utf8')
    const occurrences = app.match(/GurenPluginVercelProvider/g)?.length ?? 0
    expect(occurrences).toBe(2)

    const gitignore = await readFile('.gitignore', 'utf8')
    expect(gitignore.match(/\.vercel/g)?.length ?? 0).toBe(1)
  })

  it('rejects the official Vercel plugin for non-SSR apps', async () => {
    await writeFile('package.json', JSON.stringify({
      name: 'plugin-test-app',
      type: 'module',
      scripts: {
        build: 'bun run codegen && bunx vite build',
      },
      dependencies: {
        '@guren/core': '^0.2.0-alpha.7',
      },
    }, null, 2))

    await expect(installPlugin({ packageName: '@guren/plugin-vercel' })).rejects.toThrow('SSR web apps only')

    const app = await readFile('src/app.ts', 'utf8')
    expect(app).not.toContain('GurenPluginVercelProvider')
  })
})
