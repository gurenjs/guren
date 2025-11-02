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
   * Override the executable launched to regenerate route types. Defaults to `bun`.
   */
  executable?: string
  /**
   * Arguments passed to the executable. Defaults to `['x', '--bun', 'guren', 'routes:types', '--force']`.
   */
  args?: string[]
  /**
   * Additional environment variables passed to the spawned process.
   */
  env?: NodeJS.ProcessEnv
}

const DEFAULT_EXECUTABLE = 'bun'
const DEFAULT_ARGS = ['x', '--bun', 'guren', 'routes:types', '--force']
const DEFAULT_WATCH_FILE = 'routes/web.ts'

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
      await enqueueGeneration(appRoot)
    },
    async handleHotUpdate(ctx: HmrContext) {
      const root = appRoot ?? ctx.server.config.root
      const watchFile = resolve(root, options.watchFile ?? DEFAULT_WATCH_FILE)
      const changedFile = resolve(ctx.file)

      if (changedFile === watchFile) {
        await enqueueGeneration(root)
      }

      return ctx.modules
    },
  }
}

export default routeTypesPlugin
