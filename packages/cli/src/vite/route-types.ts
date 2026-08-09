import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import type { HmrContext, Logger, Plugin, ResolvedConfig } from 'vite'

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
   * Relative path (from the app root) to the translation directory. Defaults to `lang`.
   */
  langDir?: string
  /**
   * Override the executable launched to regenerate route types. Defaults to `bun`.
   */
  executable?: string
  /**
   * Arguments passed to the executable. Defaults to `['x', '--bun', 'guren', 'codegen', '--force']`.
   */
  args?: string[]
  /**
   * Additional environment variables passed to the spawned process.
   */
  env?: NodeJS.ProcessEnv
}

const DEFAULT_EXECUTABLE = 'bun'
const DEFAULT_ARGS = ['x', '--bun', 'guren', 'codegen', '--force']
const DEFAULT_WATCH_FILE = 'routes/web.ts'
const DEFAULT_PAGES_DIR = 'resources/js/pages'
const DEFAULT_RESOURCES_DIR = 'app/Http/Resources'
const DEFAULT_LANG_DIR = 'lang'

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
      const args = options.args ?? DEFAULT_ARGS
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

  return {
    name: 'guren-route-types',
    async configResolved(config: ResolvedConfig) {
      appRoot = resolve(config.root, options.appRoot ?? '.')
      logger = config.logger
      // Skip route type generation in CI (codegen runs as a separate build step)
      if (process.env.CI) return
      await enqueueGeneration(appRoot)
    },
    async handleHotUpdate(ctx: HmrContext) {
      const root = appRoot ?? ctx.server.config.root
      const watchFile = resolve(root, options.watchFile ?? DEFAULT_WATCH_FILE)
      const pagesDir = resolve(root, options.pagesDir ?? DEFAULT_PAGES_DIR)
      const resourcesDir = resolve(root, options.resourcesDir ?? DEFAULT_RESOURCES_DIR)
      const langDir = resolve(root, options.langDir ?? DEFAULT_LANG_DIR)
      const changedFile = resolve(ctx.file)

      if (
        changedFile === watchFile ||
        changedFile.startsWith(`${pagesDir}/`) || changedFile === pagesDir ||
        changedFile.startsWith(`${resourcesDir}/`) || changedFile === resourcesDir ||
        changedFile.startsWith(`${langDir}/`) || changedFile === langDir
      ) {
        await enqueueGeneration(root)
      }

      return ctx.modules
    },
  }
}

export default routeTypesPlugin
