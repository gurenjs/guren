import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type { ProjectContext } from './context'
import type { EntityContext } from './entity-context'
import type { ContextRoute } from './context-route'

const execFileAsync = promisify(execFile)

/** A wedged child must not hold an MCP request open forever. */
const TIMEOUT_MS = 60_000

/** Context JSON for a large app comfortably exceeds Node's 1 MB default. */
const MAX_BUFFER = 32 * 1024 * 1024

/** Keeps a stack trace or an unexpected stderr dump from flooding the reply. */
const MAX_ERROR_CHARS = 2000

/**
 * Absolute path to this package's own CLI entry: `bin.js` beside the built
 * chunk, `bin.ts` beside this file when running from source.
 */
let cachedBinPath: string | undefined

function resolveBinPath(): string {
  if (cachedBinPath) {
    return cachedBinPath
  }

  for (const candidate of ['./bin.js', './bin.ts']) {
    const path = fileURLToPath(new URL(candidate, import.meta.url))
    if (existsSync(path)) {
      cachedBinPath = path
      return path
    }
  }

  throw new Error('Could not locate the guren CLI entry point next to @guren/cli.')
}

/**
 * Every failure this module can hit is a single-line `consola.error(message)`,
 * which consola's fancy reporter renders as an ANSI-colored ` ERROR  <message>`
 * badge line (always the word, never an icon). Everything else on stderr is
 * unrelated noise, so pick out that line and fall back to the raw text.
 */
function cleanStderr(stderr: string): string {
  const lines = stderr.replace(/\x1b\[[0-9;]*m/gu, '').split('\n')
  const errorLine = lines.find((line) => /^\s*ERROR\s+/u.test(line))

  const message = errorLine
    ? errorLine.replace(/^\s*ERROR\s+/u, '')
    : lines.filter((line) => line.trim()).join('\n')

  return message.trim().slice(0, MAX_ERROR_CHARS)
}

async function runCli(args: string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(process.execPath, [resolveBinPath(), ...args], {
      cwd,
      timeout: TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
    })
    return stdout
  } catch (error) {
    const stderr = typeof (error as { stderr?: unknown }).stderr === 'string'
      ? cleanStderr((error as { stderr: string }).stderr)
      : ''
    throw new Error(stderr || (error instanceof Error ? error.message : String(error)))
  }
}

/**
 * A dependency loaded while the routes graph is imported can log to stdout
 * (`@guren/orm`'s duplicate-copy warning, or the app's own code). The payload
 * is printed by a single trailing `console.log(JSON.stringify(...))`, so it is
 * always the *last* line starting at column 0 — taking the first would pick up
 * earlier noise that happens to look like JSON.
 */
function extractJson(stdout: string): string {
  const lines = stdout.split('\n')

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (/^\{/u.test(lines[i])) {
      return lines.slice(i).join('\n')
    }
  }

  return stdout
}

async function runCliJson<T>(args: string[], cwd: string): Promise<T> {
  const stdout = await runCli([...args, '--json'], cwd)

  try {
    return JSON.parse(extractJson(stdout)) as T
  } catch {
    throw new Error(
      `guren ${args.join(' ')} --json did not produce JSON: ${stdout.trim().slice(0, 200)}`,
    )
  }
}

/**
 * The subset of context generation a long-lived process must not call
 * in-process: everything here reaches `loadRouteDefinitions()`, whose module
 * graph is frozen for the process lifetime (see `load-routes.ts`), so a dev
 * server would answer every MCP request from the graph captured at the first
 * one. A child process re-evaluates the whole graph, which no in-process trick
 * can do on Bun. Returns the same shapes as the in-process functions, and is
 * structurally compatible with `GurenCliApi` in `@guren/server` — keep the
 * signatures in sync with that interface.
 */
export function createFreshContextApi(): {
  generateContext(options: { cwd: string }): Promise<ProjectContext>
  generateEntityContext(
    entity: string,
    options: { cwd: string; module?: string },
  ): Promise<EntityContext>
  loadContextRoutes(
    cwd: string,
    routesFile?: string,
    loadErrors?: string[],
  ): Promise<ContextRoute[]>
} {
  return {
    generateContext: ({ cwd }) => runCliJson<ProjectContext>(['context'], cwd),

    generateEntityContext: (entity, { cwd, module }) =>
      runCliJson<EntityContext>(
        module ? ['context', entity, '--module', module] : ['context', entity],
        cwd,
      ),

    // The child still builds the whole context to hand back one field; a
    // routes-only CLI output would be needed to avoid that. Both parameters are
    // honoured rather than dropped: without forwarding `routesError` through
    // `loadErrors`, a routes file that throws comes back as an empty list no
    // caller can tell from an app with no routes.
    loadContextRoutes: async (cwd, routesFile, loadErrors) => {
      const context = await runCliJson<ProjectContext>(
        routesFile ? ['context', '--routes', routesFile] : ['context'],
        cwd,
      )
      if (context.routesError) loadErrors?.push(context.routesError)
      return context.routes
    },
  }
}
