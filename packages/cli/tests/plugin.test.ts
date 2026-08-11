import { beforeEach, afterEach, describe, expect, it } from 'bun:test'
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { CAN_DENY_FILE_READS, createTempWorkspace, writeInstalledPackage, type TempWorkspace } from './helpers'
import { installPlugin, type PluginInstallMessage } from '../src/plugin'

function textsOf(messages: PluginInstallMessage[], kind: PluginInstallMessage['kind']): string[] {
  return messages.filter((message) => message.kind === kind).map((message) => message.text)
}

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

  // The refusal has to land before src/app.ts is patched: throwing once the
  // provider is wired would leave a manifest we refused to honour half-installed.
  it('refuses a manifest with a reserved env key without touching the app', async () => {
    await writeInstalledPackage('@acme/guren-plugin-audit', {
      gurenPlugin: {
        provider: 'AuditProvider',
        env: [{ key: 'GUREN_TESTING', value: '1' }],
      },
    })

    await expect(
      installPlugin({ packageName: '@acme/guren-plugin-audit' }),
    ).rejects.toThrow('reserved by the framework')

    const app = await readFile('src/app.ts', 'utf8')
    expect(app).not.toContain('@acme/guren-plugin-audit')
    expect(app).toContain('providers: []')
    expect(await readFile('.env.example', 'utf8').catch(() => null)).toBeNull()
  })

  it('registers provider import and provider entry', async () => {
    const messages = await installPlugin({ packageName: '@acme/guren-plugin-audit' })

    expect(textsOf(messages, 'updated')).toContain('src/app.ts')
    expect(textsOf(messages, 'hint')).toContain('Run: bun add @acme/guren-plugin-audit')

    const app = await readFile('src/app.ts', 'utf8')
    expect(app).toContain("import { AcmeGurenPluginAuditProvider } from '@acme/guren-plugin-audit'")
    expect(app).toContain('providers: [AcmeGurenPluginAuditProvider]')
  })

  // The dependency probe used to rethrow anything that was not ENOENT, so an
  // unreadable manifest aborted the whole command before src/app.ts was
  // touched. Registering the provider is the useful half and does not depend on
  // knowing whether the package is already installed — only the install hint
  // does, and over-offering it is harmless.
  it.skipIf(!CAN_DENY_FILE_READS)('registers the provider when package.json cannot be read', async () => {
    await chmod('package.json', 0o000)

    try {
      const messages = await installPlugin({ packageName: '@acme/guren-plugin-audit' })

      expect(textsOf(messages, 'updated')).toContain('src/app.ts')
      expect(await readFile('src/app.ts', 'utf8')).toContain('providers: [AcmeGurenPluginAuditProvider]')
    } finally {
      await chmod('package.json', 0o644)
    }
  })

  it('is idempotent when plugin provider already exists', async () => {
    await installPlugin({ packageName: '@acme/guren-plugin-audit' })
    const second = await installPlugin({ packageName: '@acme/guren-plugin-audit' })

    expect(textsOf(second, 'checked')).toContain('src/app.ts (already registered)')

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

    const messages = await installPlugin({ packageName: '@acme/guren-plugin-audit' })
    expect(textsOf(messages, 'hint')).toHaveLength(0)
  })

  it('scaffolds official Vercel plugin files for SSR apps', async () => {
    const messages = await installPlugin({ packageName: '@guren/plugin-vercel' })
    const updated = textsOf(messages, 'updated')

    expect(updated).toContain('src/app.ts')
    expect(updated).toContain('package.json')
    expect(updated).toContain('.gitignore')
    expect(updated).toContain('src/vercel.ts')
    expect(updated).toContain('scripts/vercel-build.ts')
    expect(updated).toContain('vercel.json')
    expect(textsOf(messages, 'hint')).toContain('Run: bun add @guren/plugin-vercel')

    const app = await readFile('src/app.ts', 'utf8')
    expect(app).toContain("import { vercelPlugin } from '@guren/plugin-vercel'")
    expect(app).toContain('providers: [vercelPlugin()]')

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

    expect(textsOf(second, 'checked')).toContain('src/app.ts (already registered)')

    const app = await readFile('src/app.ts', 'utf8')
    const occurrences = app.match(/vercelPlugin/g)?.length ?? 0
    expect(occurrences).toBe(2)

    const gitignore = await readFile('.gitignore', 'utf8')
    expect(gitignore.match(/\.vercel/g)?.length ?? 0).toBe(1)
  })

  it('scaffolds official Lambda plugin files', async () => {
    const messages = await installPlugin({ packageName: '@guren/plugin-lambda' })
    const updated = textsOf(messages, 'updated')

    expect(updated).toContain('src/app.ts')
    expect(updated).toContain('.gitignore')
    expect(updated).toContain('src/lambda.ts')
    // Projects predating src/console.ts would otherwise get an entrypoint
    // importing a file they don't have.
    expect(updated).toContain('src/console.ts')
    // Pinned to the create-app templates so the two can't silently drift —
    // this is exactly what happened once, when #223 rewrote both templates'
    // comment without touching this scaffold's copy.
    const consoleEntry = await readFile('src/console.ts', 'utf8')
    const canonicalConsoleEntry = await readFile(
      resolve(import.meta.dir, '../../create-app/templates/default/src/console.ts'),
      'utf8',
    )
    expect(consoleEntry).toBe(canonicalConsoleEntry)
    expect(textsOf(messages, 'hint')).toContain('Run: bun add @guren/plugin-lambda')

    const app = await readFile('src/app.ts', 'utf8')
    expect(app).toContain("import { lambdaPlugin } from '@guren/plugin-lambda'")
    expect(app).toContain('providers: [lambdaPlugin()]')

    expect(await readFile('.gitignore', 'utf8')).toContain('.lambda')

    const entrypoint = await readFile('src/lambda.ts', 'utf8')
    expect(entrypoint).toContain("from '@guren/core/lambda'")
    expect(entrypoint).toContain('export const http = createLambdaHandler(app)')
    expect(entrypoint).toContain('export const queue = createSqsHandler()')

    // A second kernel here would diverge from `bun run console`'s command set.
    expect(entrypoint).toContain("import { kernel } from './console.js'")
    expect(entrypoint).not.toContain('new ConsoleKernel(')
  })

  it('is idempotent for the official Lambda plugin', async () => {
    await installPlugin({ packageName: '@guren/plugin-lambda' })
    const second = await installPlugin({ packageName: '@guren/plugin-lambda' })

    expect(textsOf(second, 'checked')).toContain('src/app.ts (already registered)')

    const app = await readFile('src/app.ts', 'utf8')
    const occurrences = app.match(/lambdaPlugin/g)?.length ?? 0
    expect(occurrences).toBe(2)

    const gitignore = await readFile('.gitignore', 'utf8')
    expect(gitignore.match(/\.lambda/g)?.length ?? 0).toBe(1)
  })

  it('honors a stale installed manifest that still declares a class provider', async () => {
    await writeInstalledPackage('@guren/plugin-vercel', {
      version: '0.1.2',
      gurenPlugin: { provider: 'GurenPluginVercelProvider' },
    })
    await writeInstalledPackage('@guren/core', { version: '1.2.0' })

    await installPlugin({ packageName: '@guren/plugin-vercel' })

    const app = await readFile('src/app.ts', 'utf8')
    expect(app).toContain("import { GurenPluginVercelProvider } from '@guren/plugin-vercel'")
    expect(app).toContain('providers: [GurenPluginVercelProvider]')
    expect(app).not.toContain('vercelPlugin')
  })

  it('registers the factory when the installed manifest omits provider', async () => {
    await writeInstalledPackage('@guren/plugin-vercel', {
      version: '0.2.0',
      gurenPlugin: { compatibility: '>=1.0.0 <2.0.0' },
    })
    await writeInstalledPackage('@guren/core', { version: '1.2.0' })

    await installPlugin({ packageName: '@guren/plugin-vercel' })

    const app = await readFile('src/app.ts', 'utf8')
    expect(app).toContain("import { vercelPlugin } from '@guren/plugin-vercel'")
    expect(app).toContain('providers: [vercelPlugin()]')
  })

  it('treats an existing configured factory call as already registered', async () => {
    await installPlugin({ packageName: '@guren/plugin-vercel' })
    const original = await readFile('src/app.ts', 'utf8')
    await writeFile('src/app.ts', original.replace('vercelPlugin()', 'vercelPlugin({ future: true })'))

    const second = await installPlugin({ packageName: '@guren/plugin-vercel' })

    expect(textsOf(second, 'checked')).toContain('src/app.ts (already registered)')
    const app = await readFile('src/app.ts', 'utf8')
    expect(app).toContain('vercelPlugin({ future: true })')
    expect(app).not.toContain('vercelPlugin()')
  })

  it('auto-registers the official Cloudflare factory plugin', async () => {
    const messages = await installPlugin({ packageName: '@guren/plugin-cloudflare' })

    expect(textsOf(messages, 'updated')).toContain('src/app.ts')

    const app = await readFile('src/app.ts', 'utf8')
    expect(app).toContain("import { cloudflarePlugin } from '@guren/plugin-cloudflare'")
    expect(app).toContain('providers: [cloudflarePlugin()]')
  })

  describe('gurenPlugin manifest', () => {
    async function writeManifestPackage(manifest: Record<string, unknown>): Promise<void> {
      await writeInstalledPackage('@acme/guren-plugin-audit', {
        version: '1.0.0',
        gurenPlugin: manifest,
      }, {
        'stubs/audit.ts': 'export const audit = true\n',
      })
      await writeInstalledPackage('@guren/core', { version: '1.2.0' })
    }

    it('uses the provider export declared in the manifest', async () => {
      await writeManifestPackage({ provider: 'AuditProvider' })

      await installPlugin({ packageName: '@acme/guren-plugin-audit' })

      const app = await readFile('src/app.ts', 'utf8')
      expect(app).toContain("import { AuditProvider } from '@acme/guren-plugin-audit'")
      expect(app).toContain('providers: [AuditProvider]')
    })

    it('throws when the plugin is incompatible with the installed core', async () => {
      await writeManifestPackage({ compatibility: '>=2.0.0' })

      await expect(installPlugin({ packageName: '@acme/guren-plugin-audit' }))
        .rejects.toThrow('declares compatibility ">=2.0.0"')

      const app = await readFile('src/app.ts', 'utf8')
      expect(app).not.toContain('guren-plugin-audit')
    })

    it('registers an incompatible plugin with a warning when ignoreCompatibility is set', async () => {
      await writeManifestPackage({ compatibility: '>=2.0.0', provider: 'AuditProvider' })

      const messages = await installPlugin({
        packageName: '@acme/guren-plugin-audit',
        ignoreCompatibility: true,
      })

      expect(textsOf(messages, 'warning')).toHaveLength(1)
      const app = await readFile('src/app.ts', 'utf8')
      expect(app).toContain('providers: [AuditProvider]')
    })

    it('does not fabricate a provider name when the manifest omits provider', async () => {
      await writeManifestPackage({ commands: { entry: 'stubs/audit.ts', names: ['audit:report'] } })

      const messages = await installPlugin({ packageName: '@acme/guren-plugin-audit' })

      expect(textsOf(messages, 'hint')).toContain(
        '@acme/guren-plugin-audit does not declare a gurenPlugin.provider; register its export manually in createApp({ providers }).',
      )
      const app = await readFile('src/app.ts', 'utf8')
      expect(app).not.toContain('guren-plugin-audit')
      expect(app).not.toContain('AcmeGurenPluginAuditProvider')
    })

    it('publishes declared files and appends env keys', async () => {
      await writeManifestPackage({
        publishes: [{ from: 'stubs/audit.ts', to: 'config/audit.ts' }],
        env: [{ key: 'AUDIT_API_KEY', comment: 'Audit API key' }],
      })

      const messages = await installPlugin({ packageName: '@acme/guren-plugin-audit' })
      const updated = textsOf(messages, 'updated')

      expect(updated).toContain('config/audit.ts')
      expect(updated).toContain('.env.example')
      expect(await readFile('config/audit.ts', 'utf8')).toBe('export const audit = true\n')
      expect(await readFile('.env.example', 'utf8')).toContain('AUDIT_API_KEY=')
    })

    it('skips existing published files without force', async () => {
      await writeManifestPackage({
        publishes: [{ from: 'stubs/audit.ts', to: 'config/audit.ts' }],
      })
      await mkdir('config', { recursive: true })
      await writeFile('config/audit.ts', 'export const custom = true\n')

      const messages = await installPlugin({ packageName: '@acme/guren-plugin-audit' })

      expect(textsOf(messages, 'skipped')).toContain('config/audit.ts (already exists, use --force to overwrite)')
      expect(await readFile('config/audit.ts', 'utf8')).toBe('export const custom = true\n')
    })
  })

  // The refusal is the whole point here: this command throws where the
  // scaffolders warn, so an import written before the array patch is one the
  // user is left to clean up by hand — and under noUnusedLocals it stops the
  // app compiling.
  it('leaves the app entry untouched when the providers array cannot be found', async () => {
    const providerless = `import { createApp } from '@guren/core'

const app = createApp({
  routes: () => {},
})

export default app
`
    await writeFile('src/app.ts', providerless)

    await expect(installPlugin({ packageName: '@acme/guren-plugin-audit' })).rejects.toThrow(
      'Could not find providers array in src/app.ts',
    )

    expect(await readFile('src/app.ts', 'utf8')).toBe(providerless)
  })

  it('registers into a root app.ts when src/app.ts is absent', async () => {
    await rm('src/app.ts')
    await writeFile('app.ts', `import { createApp } from '@guren/core'

const app = createApp({
  routes: () => {},
  providers: [],
})

export default app
`)

    const messages = await installPlugin({ packageName: '@acme/guren-plugin-audit' })

    expect(textsOf(messages, 'updated')).toContain('app.ts')

    const app = await readFile('app.ts', 'utf8')
    expect(app).toContain("import { AcmeGurenPluginAuditProvider } from '@acme/guren-plugin-audit'")
    expect(app).toContain('providers: [AcmeGurenPluginAuditProvider]')
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
    expect(app).not.toContain('vercelPlugin')
  })
})
