import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { bunExecutable, runCaptured, type CapturedExec } from './subprocess'

/**
 * The one rule for running oxlint on an app, shared by `guren gate` and the
 * harness's edit hook: which files it covers, where the shim is, and how its
 * output is read.
 */

const LINTABLE = /\.(?:ts|tsx|js|jsx|mjs|cjs)$/u
const UNLINTED_PREFIXES = ['.guren/', 'node_modules/', 'dist/', 'public/build/']

/** Whether oxlint covers this app-relative POSIX path: a source extension outside generated and vendored trees. */
export function isLintable(relPath: string): boolean {
  return LINTABLE.test(relPath) && !UNLINTED_PREFIXES.some((prefix) => relPath.startsWith(prefix))
}

/** The oxlint shim, wherever the install put it: a workspace may hoist it to an ancestor. */
export function resolveOxlint(cwd: string): string | null {
  for (let dir = cwd; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', 'oxlint', 'bin', 'oxlint')
    if (existsSync(candidate)) return candidate
    if (dirname(dir) === dir) return null
  }
}

export type OxlintRun =
  | { kind: 'not-installed' }
  | {
      kind: 'ran'
      exitCode: number
      /** The `path:line:col:` lines, warnings included. Empty with a non-zero exit is a config or plugin-load failure. */
      findings: string[]
      output: string
    }

/**
 * oxlint over `files` (everything the config covers when empty), through the shim
 * under Bun so no Node is needed. A file the config ignores is "no files to lint",
 * not a failure.
 */
export async function runOxlint(cwd: string, files: string[], exec: CapturedExec = runCaptured): Promise<OxlintRun> {
  const shim = resolveOxlint(cwd)
  if (shim === null) return { kind: 'not-installed' }
  const result = await exec(
    [bunExecutable(), shim, '--no-error-on-unmatched-pattern', '--format', 'unix', ...files],
    cwd,
  )
  const findings = result.stdout.split('\n').filter((line) => /^[^\s:]+:\d+:\d+:/u.test(line))
  return { kind: 'ran', exitCode: result.exitCode, findings, output: `${result.stdout}${result.stderr}`.trimEnd() }
}
