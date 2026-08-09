import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { HmrContext, Logger, Plugin, ResolvedConfig, ViteDevServer } from 'vite'

export interface RouteTypesPluginOptions {
  /**
   * Application root used to resolve the command working directory. Defaults to Vite's resolved root.
   */
  appRoot?: string
  /**
   * Relative path (from the app root) to watch for changes. Defaults to `routes/web.ts`.
   * Forwarded to the spawned codegen as `--routes`.
   */
  watchFile?: string
  /**
   * Relative path (from the app root) to the frontend pages directory. Defaults to `resources/js/pages`.
   * Forwarded to the spawned codegen as `--pages`.
   */
  pagesDir?: string
  /**
   * Relative path (from the app root) to the Resources directory. Defaults to `app/Http/Resources`.
   * Watch-only: codegen (like make:resource and check) always scans the conventional
   * directory, so this option cannot relocate it.
   */
  resourcesDir?: string
  /**
   * Override the executable launched to regenerate route types. Defaults to `bun`.
   */
  executable?: string
  /**
   * Arguments passed to the executable, replacing the generated command entirely.
   * By default the plugin invokes the `@guren/cli` codegen entry directly, passing
   * `watchFile`/`pagesDir` as `--routes`/`--pages`. Pass `args: ['run', 'codegen']`
   * when your app's codegen npm script carries extra flags or a pre-step, so
   * watcher-triggered regeneration matches that script exactly.
   */
  args?: string[]
  /**
   * Additional environment variables passed to the spawned process.
   */
  env?: NodeJS.ProcessEnv
}

const DEFAULT_EXECUTABLE = 'bun'
const FALLBACK_ARGS = ['x', '--bun', 'guren', 'codegen', '--force']
const DEFAULT_WATCH_FILE = 'routes/web.ts'
const DEFAULT_PAGES_DIR = 'resources/js/pages'
const DEFAULT_RESOURCES_DIR = 'app/Http/Resources'
// Fixed by convention across codegen and check (see cli/src/i18n-types.ts).
const DEFAULT_LANG_DIR = 'lang'

/**
 * The one place plugin path options are defaulted: `shouldRegenerate` (what to
 * watch) and `resolveCodegenCommand` (what to scan) both read from here, so the
 * watched and scanned locations cannot drift apart.
 */
function resolvePathOptions(options: RouteTypesPluginOptions) {
  return {
    watchFile: options.watchFile ?? DEFAULT_WATCH_FILE,
    pagesDir: options.pagesDir ?? DEFAULT_PAGES_DIR,
    resourcesDir: options.resourcesDir ?? DEFAULT_RESOURCES_DIR,
  }
}

/**
 * The `guren` bin name only resolves in apps whose install links a bin shim;
 * workspaces that symlink @guren/cli without one make `bun x` fall through to
 * the npm registry, where `guren` is unpublished, and 404. The CLI entry always
 * ships alongside this module (dist/bin.js next to the bundled chunk, src/bin.ts
 * when running from source), so prefer resolving it directly.
 */
function resolveCliEntry(): string | undefined {
  for (const candidate of ['./bin.js', './bin.ts', '../bin.js', '../bin.ts']) {
    const path = fileURLToPath(new URL(candidate, import.meta.url))
    if (existsSync(path)) return path
  }
  return undefined
}

export function resolveCodegenCommand(options: RouteTypesPluginOptions): {
  executable: string
  args: string[]
} {
  const executable = options.executable ?? DEFAULT_EXECUTABLE
  if (options.args) {
    return { executable, args: options.args }
  }
  const { watchFile, pagesDir } = resolvePathOptions(options)
  const cliEntry = resolveCliEntry()
  const base = cliEntry ? [cliEntry, 'codegen', '--force'] : [...FALLBACK_ARGS]
  return { executable, args: [...base, '--routes', watchFile, '--pages', pagesDir] }
}

export function routeTypesPlugin(options: RouteTypesPluginOptions = {}): Plugin {
  let appRoot = options.appRoot
  let logger: Logger | undefined
  let queue: Promise<void> = Promise.resolve()

  function logLines(message: string, level: 'info' | 'error' = 'info'): void {
    const target = level === 'error' ? logger?.error : logger?.info
    const fallback = level === 'error' ? console.error : console.info
    const writer = target?.bind(logger) ?? fallback

    for (const line of message.split(/\r?\n/).filter(Boolean)) {
      writer(`[guren-route-types] ${line}`)
    }
  }

  function spawnGenerator(root: string): Promise<void> {
    return new Promise((resolvePromise, rejectPromise) => {
      const { executable, args } = resolveCodegenCommand(options)
      const child = spawn(executable, args, {
        cwd: root,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ...options.env },
      })

      let stdout = ''
      let stderr = ''

      child.stdout?.on('data', (chunk) => {
        stdout += chunk.toString()
      })

      child.stderr?.on('data', (chunk) => {
        stderr += chunk.toString()
      })

      child.on('error', (error) => {
        rejectPromise(error)
      })

      child.on('close', (code) => {
        if (code === 0) {
          if (stdout.trim()) {
            logLines(stdout.trim(), 'info')
          }
          resolvePromise()
        } else {
          const output = [stderr.trim(), stdout.trim()].filter(Boolean).join('\n')
          rejectPromise(new Error(output || `${executable} ${args.join(' ')} exited with code ${code}`))
        }
      })
    })
  }

  function enqueueGeneration(root: string): Promise<void> {
    queue = queue
      .then(() => spawnGenerator(root))
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error)
        logLines(message, 'error')
      })

    return queue
  }

  function shouldRegenerate(root: string, file: string): boolean {
    const paths = resolvePathOptions(options)
    const watchFile = resolve(root, paths.watchFile)
    const pagesDir = resolve(root, paths.pagesDir)
    const resourcesDir = resolve(root, paths.resourcesDir)
    const langDir = resolve(root, DEFAULT_LANG_DIR)
    const changedFile = resolve(file)

    return (
      changedFile === watchFile ||
      changedFile.startsWith(`${pagesDir}/`) || changedFile === pagesDir ||
      changedFile.startsWith(`${resourcesDir}/`) || changedFile === resourcesDir ||
      // Codegen only reads lang/<locale>/*.json — other files under lang/
      // (notes, fixtures) never affect the generated union.
      (changedFile.startsWith(`${langDir}/`) && changedFile.endsWith('.json'))
    )
  }

  return {
    name: 'guren-route-types',
    async configResolved(config: ResolvedConfig) {
      appRoot = resolve(config.root, options.appRoot ?? '.')
      logger = config.logger
      // Skip route type generation in CI (codegen runs as a separate build step)
      if (process.env.CI) return
      await enqueueGeneration(appRoot)
    },
    configureServer(server: ViteDevServer) {
      // handleHotUpdate only fires for updates; creating or deleting a
      // page, resource, or translation file must regenerate too.
      const root = () => appRoot ?? server.config.root
      const onFileEvent = (file: string) => {
        if (process.env.CI) return
        if (shouldRegenerate(root(), file)) {
          void enqueueGeneration(root())
        }
      }
      server.watcher.on('add', onFileEvent)
      server.watcher.on('unlink', onFileEvent)
    },
    async handleHotUpdate(ctx: HmrContext) {
      const root = appRoot ?? ctx.server.config.root

      if (shouldRegenerate(root, ctx.file)) {
        await enqueueGeneration(root)
      }

      return ctx.modules
    },
  }
}

export default routeTypesPlugin
