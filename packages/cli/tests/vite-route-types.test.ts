import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { routeTypesPlugin } from '../src/vite/route-types'

// Vite types hooks as ObjectHook unions, so they cannot be invoked off a
// Plugin-typed value; this narrows to the function forms the plugin uses.
type PluginHooks = {
  configResolved(config: unknown): Promise<void>
  configureServer(server: unknown): void
  handleHotUpdate(ctx: unknown): Promise<unknown>
}

describe('routeTypesPlugin CI skip', () => {
  let root: string
  let markerPath: string
  let originalCi: string | undefined

  // `touch` stands in for the codegen process. The hooks resolve only after the
  // spawned child closes, so the marker's presence is already decided when
  // their awaits return — no settle waits needed.
  function createPlugin(): PluginHooks {
    return routeTypesPlugin({ executable: 'touch', args: [markerPath] }) as unknown as PluginHooks
  }

  function hotUpdate(
    plugin: PluginHooks,
    modules: unknown[] = [],
    file = join(root, 'routes/web.ts'),
  ): Promise<unknown> {
    return plugin.handleHotUpdate({ file, server: { config: { root } }, modules })
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'guren-route-types-'))
    markerPath = join(root, 'codegen-ran')
    originalCi = process.env.CI
  })

  afterEach(async () => {
    if (originalCi === undefined) {
      delete process.env.CI
    } else {
      process.env.CI = originalCi
    }
    await rm(root, { recursive: true, force: true })
  })

  it('should not spawn codegen from configResolved when CI is set', async () => {
    process.env.CI = '1'
    const plugin = createPlugin()

    await plugin.configResolved({ root, logger: undefined })

    expect(existsSync(markerPath)).toBe(false)
  })

  it('should not spawn codegen from watcher add/unlink events when CI is set', async () => {
    process.env.CI = '1'
    const plugin = createPlugin()
    const handlers: Record<string, (file: string) => void> = {}

    plugin.configureServer({
      config: { root },
      watcher: {
        on(event: string, callback: (file: string) => void) {
          handlers[event] = callback
        },
      },
    })

    expect(handlers.add).toBeDefined()
    expect(handlers.unlink).toBeDefined()
    handlers.add!(join(root, 'resources/js/pages/Home.tsx'))
    handlers.unlink!(join(root, 'resources/js/pages/Home.tsx'))
    // The watcher handler fires and forgets, so drain the plugin's shared
    // generation queue through a hook that returns it.
    await hotUpdate(plugin)

    expect(existsSync(markerPath)).toBe(false)
  })

  it('should not spawn codegen from handleHotUpdate when CI is set', async () => {
    process.env.CI = '1'
    const plugin = createPlugin()
    const modules: unknown[] = []

    const result = await hotUpdate(plugin, modules)

    expect(result).toBe(modules)
    expect(existsSync(markerPath)).toBe(false)
  })

  it('should spawn codegen from handleHotUpdate when CI is not set', async () => {
    // Positive control: the CI assertions above must be able to fail.
    delete process.env.CI
    const plugin = createPlugin()

    await hotUpdate(plugin)

    expect(existsSync(markerPath)).toBe(true)
  })
})

/**
 * The watcher has to keep up with what codegen scans: `generateDataTypes` fans
 * out over `modules/<name>/app/Http/Resources`, and a watcher seeing only the
 * project-root copy leaves a module's `Data` types stale for the whole session.
 */
describe('routeTypesPlugin watches module Resources', () => {
  let root: string
  let markerPath: string
  let originalCi: string | undefined

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'guren-route-types-modules-'))
    markerPath = join(root, 'codegen-ran')
    originalCi = process.env.CI
    delete process.env.CI
  })

  afterEach(async () => {
    if (originalCi === undefined) delete process.env.CI
    else process.env.CI = originalCi
    await rm(root, { recursive: true, force: true })
  })

  async function touchedBy(relativePath: string): Promise<boolean> {
    const plugin = routeTypesPlugin({ executable: 'touch', args: [markerPath] }) as unknown as PluginHooks
    await plugin.handleHotUpdate({
      file: join(root, relativePath),
      server: { config: { root } },
      modules: [],
    })
    return existsSync(markerPath)
  }

  it('regenerates for a Resource inside a module', async () => {
    expect(await touchedBy('modules/billing/app/Http/Resources/InvoiceResource.ts')).toBe(true)
  })

  it('still regenerates for a Resource at the project root', async () => {
    expect(await touchedBy('app/Http/Resources/PostResource.ts')).toBe(true)
  })

  it('regenerates for a Model inside a module', async () => {
    // Models feed attachments.gen.ts.
    expect(await touchedBy('modules/billing/app/Models/Invoice.ts')).toBe(true)
  })

  it('regenerates for a Model at the project root', async () => {
    expect(await touchedBy('app/Models/Post.ts')).toBe(true)
  })

  it('ignores other files inside a module', async () => {
    // Matched by shape: a module's controllers feed no generated artifact.
    expect(await touchedBy('modules/billing/app/Http/Controllers/InvoiceController.ts')).toBe(false)
  })
})
