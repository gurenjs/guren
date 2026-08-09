import { spawn } from 'node:child_process'
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
   */
  watchFile?: string
  /**
   * Relative path (from the app root) to the frontend pages directory. Defaults to `resources/js/pages`.
   */
  pagesDir?: string
  /**
   * Relative path (from the app root) to the Resources directory. Defaults to `app/Http/Resources`.
   */
  resourcesDir?: string
  /**
   * Override the executable launched to regenerate route types. Defaults to `bun`.
   */
  executable?: string
  /**
   * Arguments passed to the executable. Defaults to running this package's own
   * `guren` bin entry with `['codegen', '--force']`.
   */
  args?: string[]
  /**
   * Additional environment variables passed to the spawned process.
   */
  env?: NodeJS.ProcessEnv
}

const DEFAULT_EXECUTABLE = 'bun'
const DEFAULT_WATCH_FILE = 'routes/web.ts'
const DEFAULT_PAGES_DIR = 'resources/js/pages'
const DEFAULT_RESOURCES_DIR = 'app/Http/Resources'
// Fixed by convention across codegen and check (see cli/src/i18n-types.ts).
const DEFAULT_LANG_DIR = 'lang'

let cachedDefaultArgs: string[] | undefined

// Self-referencing this package's name needs no linked `.bin/guren` (`bun x
// guren` consults the npm registry, where the package does not exist) and
// works for workspace links and npm installs alike. Lazy so consumers who
// override `args` never resolve, and a failure surfaces through the
// generation error path instead of breaking the module import.
function defaultArgs(): string[] {
  cachedDefaultArgs ??= [fileURLToPath(import.meta.resolve('@guren/cli/bin')), 'codegen', '--force']
  return cachedDefaultArgs
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
      const executable = options.executable ?? DEFAULT_EXECUTABLE
      const args = options.args ?? defaultArgs()
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
    // CI runs codegen as its own build step; regenerating there — including
    // from watcher or HMR events mid-E2E — would only add nondeterminism.
    if (process.env.CI) return queue

    queue = queue
      .then(() => spawnGenerator(root))
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error)
        logLines(message, 'error')
      })

    return queue
  }

  function shouldRegenerate(root: string, file: string): boolean {
    const watchFile = resolve(root, options.watchFile ?? DEFAULT_WATCH_FILE)
    const pagesDir = resolve(root, options.pagesDir ?? DEFAULT_PAGES_DIR)
    const resourcesDir = resolve(root, options.resourcesDir ?? DEFAULT_RESOURCES_DIR)
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
      await enqueueGeneration(appRoot)
    },
    configureServer(server: ViteDevServer) {
      // handleHotUpdate only fires for updates; creating or deleting a
      // page, resource, or translation file must regenerate too.
      const root = () => appRoot ?? server.config.root
      const onFileEvent = (file: string) => {
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
