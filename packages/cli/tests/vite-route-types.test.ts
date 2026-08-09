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

  // `touch` stands in for the codegen process: the marker file existing
  // is the observable proof that a generation was spawned. The hooks
  // resolve only after the spawned child closes, so the marker's presence
  // is already decided when their awaits return — no settle waits needed.
  function createPlugin(): PluginHooks {
    return routeTypesPlugin({ executable: 'touch', args: [markerPath] }) as unknown as PluginHooks
  }

  function hotUpdate(plugin: PluginHooks, modules: unknown[] = []): Promise<unknown> {
    return plugin.handleHotUpdate({
      file: join(root, 'routes/web.ts'),
      server: { config: { root } },
      modules,
    })
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
    // generation queue through a hook that returns it: any spawn a
    // regression chained onto the queue has closed once this resolves.
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
    // Positive control: proves the marker mechanism can detect a spawn,
    // so the CI assertions above are able to fail.
    delete process.env.CI
    const plugin = createPlugin()

    await hotUpdate(plugin)

    expect(existsSync(markerPath)).toBe(true)
  })
})
