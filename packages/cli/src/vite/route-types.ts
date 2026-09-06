import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import type { HmrContext, Logger, Plugin, ResolvedConfig, ViteDevServer } from 'vite'
import { MODELS_DIR, RESOURCES_DIR, toPosixRelative } from '../discovery'
import { escapeRegExp } from '../utils'
import { cliEntry } from '../cli-entry'

export interface RouteTypesPluginOptions {
  /**
   * Application root the command's working directory resolves from. Defaults to Vite's resolved root.
   */
  appRoot?: string
  /**
   * Routes file to watch, relative to the app root. Defaults to `routes/web.ts`; forwarded as `--routes`.
   */
  watchFile?: string
  /**
   * Frontend pages directory, relative to the app root. Defaults to `resources/js/pages`; forwarded as `--pages`.
   */
  pagesDir?: string
  /**
   * Resources directory, relative to the app root. Defaults to `app/Http/Resources`.
   * Watch-only: codegen always scans the conventional directory, so this cannot relocate it.
   */
  resourcesDir?: string
  /**
   * Override the executable launched to regenerate route types. Defaults to `bun`.
   */
  executable?: string
  /**
   * Arguments passed to the executable, replacing the generated command entirely.
   * Pass `['run', 'codegen']` when the app's codegen script carries extra flags or a pre-step.
   */
  args?: string[]
  /**
   * Additional environment variables passed to the spawned process.
   */
  env?: NodeJS.ProcessEnv
  /**
   * Whether the plugin regenerates types at all. Defaults to `!process.env.CI`
   * (codegen runs as a separate build step in CI).
   */
  enabled?: boolean
}

const DEFAULT_EXECUTABLE = 'bun'
const DEFAULT_WATCH_FILE = 'routes/web.ts'
const DEFAULT_PAGES_DIR = 'resources/js/pages'
// Fixed by convention across codegen and check (see cli/src/i18n-types.ts).
const DEFAULT_LANG_DIR = 'lang'
// Models feed attachments.gen.ts: an edited Attachable(...) must regenerate the
// map, root and module models alike. Matched POSIX-relative, so also Windows-safe.
const MODELS_PATTERN = new RegExp(`^(?:modules/[^/]+/)?${escapeRegExp(MODELS_DIR)}(?:/|$)`, 'u')

/**
 * The one place path options are defaulted: `shouldRegenerate` (what to watch) and
 * `resolveCodegenCommand` (what to scan) both read it, so the two cannot drift apart.
 */
function resolvePathOptions(options: RouteTypesPluginOptions) {
  return {
    watchFile: options.watchFile ?? DEFAULT_WATCH_FILE,
    pagesDir: options.pagesDir ?? DEFAULT_PAGES_DIR,
    resourcesDir: options.resourcesDir ?? RESOURCES_DIR,
  }
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
  return { executable, args: [cliEntry(), 'codegen', '--force', '--routes', watchFile, '--pages', pagesDir] }
}

export function routeTypesPlugin(options: RouteTypesPluginOptions = {}): Plugin {
  const enabled = options.enabled ?? !process.env.CI
  let appRoot = options.appRoot
  let logger: Logger | undefined
  let running: Promise<void> | null = null
  let queued = false

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

  function runGeneration(root: string): Promise<void> {
    return spawnGenerator(root).catch((error) => {
      const message = error instanceof Error ? error.message : String(error)
      logLines(message, 'error')
    })
  }

  function scheduleGeneration(root: string): Promise<void> {
    if (!enabled) return Promise.resolve()

    // Events arriving mid-run collapse into one follow-up run covering all their changes.
    if (running) {
      queued = true
      return running
    }

    running = (async () => {
      do {
        queued = false
        await runGeneration(root)
      } while (queued)
    })().finally(() => {
      running = null
    })

    return running
  }

  function shouldRegenerate(root: string, file: string): boolean {
    const paths = resolvePathOptions(options)
    const watchFile = resolve(root, paths.watchFile)
    const pagesDir = resolve(root, paths.pagesDir)
    const resourcesDir = resolve(root, paths.resourcesDir)
    // Codegen also scans each `modules/<name>/` Resources dir; watching only the
    // root leaves a module's Data types stale for the session with no signal.
    // Matched by shape, so a module created mid-session needs no restart.
    const moduleResources = new RegExp(`^modules/[^/]+/${escapeRegExp(paths.resourcesDir)}(?:/|$)`, 'u')
    const langDir = resolve(root, DEFAULT_LANG_DIR)
    const changedFile = resolve(file)

    if (
      changedFile === watchFile ||
      changedFile.startsWith(`${pagesDir}/`) || changedFile === pagesDir ||
      changedFile.startsWith(`${resourcesDir}/`) || changedFile === resourcesDir ||
      // Codegen only reads lang/<locale>/*.json; other files under lang/ never affect the union.
      (changedFile.startsWith(`${langDir}/`) && changedFile.endsWith('.json'))
    ) {
      return true
    }

    // Relativized only when the cheap prefix checks above miss: this runs on every watcher event.
    const relativeFile = toPosixRelative(root, changedFile)
    return moduleResources.test(relativeFile) || MODELS_PATTERN.test(relativeFile)
  }

  return {
    name: 'guren-route-types',
    async configResolved(config: ResolvedConfig) {
      appRoot = resolve(config.root, options.appRoot ?? '.')
      logger = config.logger
      await scheduleGeneration(appRoot)
    },
    configureServer(server: ViteDevServer) {
      // handleHotUpdate only fires for updates; creation and deletion must regenerate too.
      const root = () => appRoot ?? server.config.root
      const onFileEvent = (file: string) => {
        if (shouldRegenerate(root(), file)) {
          void scheduleGeneration(root())
        }
      }
      server.watcher.on('add', onFileEvent)
      server.watcher.on('unlink', onFileEvent)
    },
    async handleHotUpdate(ctx: HmrContext) {
      const root = appRoot ?? ctx.server.config.root

      if (shouldRegenerate(root, ctx.file)) {
        await scheduleGeneration(root)
      }

      return ctx.modules
    },
  }
}

export default routeTypesPlugin
