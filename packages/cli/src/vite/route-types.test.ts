import { describe, it, test, expect, beforeEach, afterEach } from 'bun:test'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import type { HmrContext, Logger, Plugin, ResolvedConfig, ViteDevServer } from 'vite'
import { resolveCodegenCommand, routeTypesPlugin, type RouteTypesPluginOptions } from './route-types'

const CODEGEN_TAIL = ['codegen', '--force']

describe('resolveCodegenCommand', () => {
  test('should invoke the package bin entry with default paths', () => {
    const { executable, args } = resolveCodegenCommand({})

    expect(executable).toBe('bun')
    // `@guren/cli`'s own package export: `dist/bin.js` when built, `src/bin.ts` under this monorepo's path mapping.
    expect(args[0]).toMatch(/bin\.(ts|js)$/)
    expect(args.slice(1)).toEqual([
      ...CODEGEN_TAIL,
      '--routes', 'routes/web.ts',
      '--pages', 'resources/js/pages',
    ])
  })

  test('should forward configured paths as codegen flags', () => {
    const { args } = resolveCodegenCommand({
      watchFile: 'routes/api.ts',
      pagesDir: 'frontend/pages',
    })

    expect(args.slice(1)).toEqual([
      ...CODEGEN_TAIL,
      '--routes', 'routes/api.ts',
      '--pages', 'frontend/pages',
    ])
  })

  test('should let explicit args replace the generated command entirely', () => {
    expect(resolveCodegenCommand({ args: ['run', 'codegen'], pagesDir: 'frontend/pages' })).toEqual({
      executable: 'bun',
      args: ['run', 'codegen'],
    })
  })

  test('should respect an executable override', () => {
    const { executable } = resolveCodegenCommand({ executable: 'node' })
    expect(executable).toBe('node')
  })
})

describe('routeTypesPlugin', () => {
  let tempDir: string
  let runLog: string
  let originalCi: string | undefined

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'guren-route-types-'))
    runLog = join(tempDir, 'runs.log')
    originalCi = process.env.CI
    delete process.env.CI
  })

  afterEach(async () => {
    if (originalCi === undefined) {
      delete process.env.CI
    } else {
      process.env.CI = originalCi
    }
    await rm(tempDir, { recursive: true, force: true })
  })

  function createPlugin(options: RouteTypesPluginOptions = {}): Plugin {
    return routeTypesPlugin({
      appRoot: tempDir,
      executable: 'bash',
      args: ['-c', 'echo run >> "$RUN_LOG"'],
      env: { RUN_LOG: runLog },
      ...options,
    })
  }

  function resolveConfig(plugin: Plugin, logger?: Partial<Logger>): Promise<void> {
    const handler = plugin.configResolved as (config: ResolvedConfig) => Promise<void>
    return handler({ root: tempDir, logger } as unknown as ResolvedConfig)
  }

  function hotUpdate(plugin: Plugin, file: string): Promise<unknown> {
    const handler = plugin.handleHotUpdate as (ctx: HmrContext) => Promise<unknown>
    const ctx = {
      file,
      server: { config: { root: tempDir } },
      modules: [],
    } as unknown as HmrContext
    return handler(ctx)
  }

  function connectWatcher(plugin: Plugin): EventEmitter {
    const watcher = new EventEmitter()
    const handler = plugin.configureServer as (server: ViteDevServer) => void
    handler({ watcher, config: { root: tempDir } } as unknown as ViteDevServer)
    return watcher
  }

  async function readRuns(): Promise<string[]> {
    const content = await readFile(runLog, 'utf8').catch(() => '')
    return content.split('\n').filter(Boolean)
  }

  async function waitForRuns(count: number): Promise<string[]> {
    const deadline = Date.now() + 2000
    let runs = await readRuns()
    while (runs.length < count && Date.now() < deadline) {
      await Bun.sleep(10)
      runs = await readRuns()
    }
    return runs
  }

  it('should coalesce events arriving during a run into one follow-up run', async () => {
    const plugin = createPlugin()
    const pageFile = (name: string) => resolve(tempDir, 'resources/js/pages', name)

    const updates = ['A.tsx', 'B.tsx', 'C.tsx', 'D.tsx', 'E.tsx'].map((name) =>
      hotUpdate(plugin, pageFile(name)),
    )
    await Promise.all(updates)

    expect(await readRuns()).toHaveLength(2)
  })

  it('should run again for events after the previous run finished', async () => {
    const plugin = createPlugin()
    const pageFile = resolve(tempDir, 'resources/js/pages/A.tsx')

    await hotUpdate(plugin, pageFile)
    await hotUpdate(plugin, pageFile)

    expect(await readRuns()).toHaveLength(2)
  })

  it('should not regenerate for files outside the watched paths', async () => {
    const plugin = createPlugin()

    await hotUpdate(plugin, resolve(tempDir, 'src/unrelated.ts'))

    expect(await readRuns()).toHaveLength(0)
  })

  it('should regenerate when the watcher reports added files', async () => {
    const plugin = createPlugin()
    const watcher = connectWatcher(plugin)

    watcher.emit('add', resolve(tempDir, 'resources/js/pages/New.tsx'))
    watcher.emit('unlink', resolve(tempDir, 'src/unrelated.ts'))

    expect(await waitForRuns(1)).toHaveLength(1)
  })

  it('should log generator failures without rejecting, and keep accepting runs', async () => {
    const errors: string[] = []
    const plugin = createPlugin({ args: ['-c', 'echo run >> "$RUN_LOG"; echo boom >&2; exit 1'] })

    await resolveConfig(plugin, {
      info: () => {},
      error: (message: string) => {
        errors.push(message)
      },
    })
    await hotUpdate(plugin, resolve(tempDir, 'resources/js/pages/A.tsx'))

    expect(await readRuns()).toHaveLength(2)
    expect(errors).toHaveLength(2)
    expect(errors[0]).toContain('boom')
  })

  it('should skip generation entirely when disabled', async () => {
    const plugin = createPlugin({ enabled: false })
    const watcher = connectWatcher(plugin)

    await resolveConfig(plugin)
    await hotUpdate(plugin, resolve(tempDir, 'resources/js/pages/A.tsx'))
    watcher.emit('add', resolve(tempDir, 'resources/js/pages/New.tsx'))

    expect(await readRuns()).toHaveLength(0)
  })

  it('should default to disabled when CI is set', async () => {
    process.env.CI = '1'
    const plugin = createPlugin()

    await resolveConfig(plugin)
    await hotUpdate(plugin, resolve(tempDir, 'resources/js/pages/A.tsx'))

    expect(await readRuns()).toHaveLength(0)
  })
})
