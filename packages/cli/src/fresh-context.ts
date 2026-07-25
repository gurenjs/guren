import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type { ProjectContext } from './context'
import type { EntityContext } from './entity-context'

const execFileAsync = promisify(execFile)

/** A wedged child must not hold an MCP request open forever. */
const TIMEOUT_MS = 60_000

/** Context JSON for a large app comfortably exceeds Node's 1 MB default. */
const MAX_BUFFER = 32 * 1024 * 1024

/** Keeps a stack trace or an unexpected stderr dump from flooding the reply. */
const MAX_ERROR_CHARS = 2000

/**
 * Absolute path to this package's own CLI entry. Built output puts `bin.js`
 * next to the chunk this module lands in; running from source resolves
 * `bin.ts` next to this file. Resolved once per process -- the answer can't
 * change between calls.
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
 * Every failure this module can hit -- an unknown entity, an unreadable
 * routes file -- is a single-line `consola.error(message)` (see
 * `displayEntityContext` in entity-context.ts), which consola's fancy
 * reporter renders as an ANSI-colored ` ERROR  <message>` badge line (its
 * badge is always the word, never an icon -- icons are reporter-internal and
 * only used for non-error levels). Everything else on stderr is unrelated
 * noise (duplicate-package warnings and the like), so pick out just that
 * line and fall back to the raw text when the process died some other way.
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
 * The CLI keeps its own diagnostics on stderr, but a dependency loaded while
 * the routes graph is imported can still log to stdout (`@guren/orm`'s
 * duplicate-copy warning is one, but nothing stops a project's own routes
 * file or a controller from doing the same). `displayContext()` /
 * `displayEntityContext()` print the payload with a single trailing
 * `console.log(JSON.stringify(...))` and nothing runs after it, so it is
 * always the *last* line starting at column 0 — taking the first such line
 * instead would pick up any earlier noise that happens to look like JSON too.
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
 * The subset of context generation that a long-lived process must not call
 * in-process. Both entries reach `loadRouteDefinitions()`, whose module graph
 * is frozen for the lifetime of the process (see the note in
 * `load-routes.ts`), so a dev server answering repeated MCP requests would
 * keep reporting the route graph as it looked at the first request — long
 * after `routes/web.ts`, a controller, or a `modules/*` route file changed.
 * Running the CLI as a child process re-evaluates the whole graph, transitive
 * imports included, which no in-process trick can do on Bun.
 *
 * The returned values are the same shapes the in-process functions return —
 * `guren context [entity] --json` prints exactly the object they build — so
 * `renderContextMarkdown()` / `renderEntityContextMarkdown()` still apply.
 *
 * Structurally compatible with the matching members of `GurenCliApi` in
 * `@guren/server`; keep the signatures in sync with that interface.
 */
export function createFreshContextApi(): {
  generateContext(options: { cwd: string }): Promise<ProjectContext>
  generateEntityContext(
    entity: string,
    options: { cwd: string; module?: string },
  ): Promise<EntityContext>
} {
  return {
    generateContext: ({ cwd }) => runCliJson<ProjectContext>(['context'], cwd),

    generateEntityContext: (entity, { cwd, module }) =>
      runCliJson<EntityContext>(
        module ? ['context', entity, '--module', module] : ['context', entity],
        cwd,
      ),
  }
}
