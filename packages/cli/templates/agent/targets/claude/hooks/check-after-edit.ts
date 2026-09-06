#!/usr/bin/env bun
/**
 * PostToolUse hook: after an agent edits a file, run `guren check` (for routes,
 * controllers, models, schema, and pages) and oxlint (for any source file, when
 * the app has an .oxlintrc.json) and feed findings back so they get fixed
 * immediately instead of surfacing later in CI.
 *
 * Exit codes: 0 = ok / not applicable, 2 = findings reported back to the agent.
 */
import { existsSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'

interface HookInput {
  tool_input?: {
    file_path?: string
  }
}

const WATCHED_PATHS = [
  'routes/',
  'app/Http/',
  'app/Models/',
  'resources/js/pages/',
  'db/schema.ts',
]

const LINTABLE = /\.(?:ts|tsx|js|jsx|mjs|cjs)$/u
const UNLINTED_PREFIXES = ['.guren/', 'node_modules/', 'dist/', 'public/build/']

let filePath = ''
try {
  const input = JSON.parse(await Bun.stdin.text()) as HookInput
  filePath = input.tool_input?.file_path ?? ''
} catch {
  process.exit(0)
}

/** Both sides resolved: on macOS `process.cwd()` is the real `/private/var/...` while the editor hands over `/var/...`. */
function real(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

// POSIX separators so the prefix lists below match on Windows too; `relative()`
// yields an absolute path across drives there, which is outside the project.
const relPath = relative(real(process.cwd()), real(filePath)).split(sep).join('/')
if (relPath === '' || isAbsolute(relPath) || relPath === '..' || relPath.startsWith('../')) {
  process.exit(0)
}

const findings: string[] = []

// Run the check in-process: this hook fires on every watched edit, and
// spawning bunx + the CLI would cost a few hundred ms per edit. `changed:
// true` restricts file-scanning checks (empty methods, architecture
// boundaries) to what's actually changed, so this stays fast as the app
// grows — it falls back to checking everything outside a git repo.
if (WATCHED_PATHS.some((prefix) => relPath.startsWith(prefix))) {
  try {
    const { runCheck, gatingResults } = await import('@guren/cli')
    // Same rule as `check --ci` and `guren gate`: warns count, advisory checks do not.
    const gating = gatingResults(await runCheck({ changed: true }))
    if (gating.length > 0) {
      findings.push(`guren check found ${gating.length} issue(s):`)
      for (const check of gating) {
        const location = check.filePath ? ` [${check.filePath}]` : ''
        const suggestion = check.suggestion ? ` → ${check.suggestion}` : ''
        findings.push(`- ${check.title}: ${check.message}${location}${suggestion}`)
      }
    }
  } catch {
    // no @guren/cli resolvable from here: nothing to check with
  }
}

/** The oxlint shim, wherever the install put it: a workspace may hoist it to an ancestor. */
function resolveOxlint(): string | null {
  for (let dir = process.cwd(); ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', 'oxlint', 'bin', 'oxlint')
    if (existsSync(candidate)) return candidate
    if (dirname(dir) === dir) return null
  }
}

// One file, through the shim under Bun (no Node needed). Warnings are reported
// too: the comment rules are warnings so `bun run lint` stays green, and the
// agent that just wrote the comment is the one who can fix it.
const lintable = LINTABLE.test(relPath) && !UNLINTED_PREFIXES.some((prefix) => relPath.startsWith(prefix)) && existsSync('.oxlintrc.json')
const oxlint = lintable ? resolveOxlint() : null
if (lintable && oxlint === null) {
  findings.push('.oxlintrc.json is present but oxlint is not installed: run `bun install`')
}
if (oxlint !== null) {
  // A file the config ignores is "no files to lint", not a failure.
  const result = Bun.spawnSync([process.execPath, oxlint, '--no-error-on-unmatched-pattern', '--format', 'unix', relPath], { stdout: 'pipe', stderr: 'pipe' })
  const stdout = result.stdout.toString()
  const lines = stdout.split('\n').filter((line) => line.startsWith(`${relPath}:`))
  if (lines.length > 0) {
    findings.push(`oxlint found ${lines.length} issue(s):`)
    findings.push(...lines.map((line) => `- ${line}`))
  } else if (result.exitCode !== 0) {
    // A config or plugin-load failure has no file prefix; it must not read as clean.
    findings.push(`oxlint exited ${result.exitCode} without linting ${relPath}:\n${stdout}${result.stderr.toString()}`.trimEnd())
  }
}

if (findings.length > 0) {
  console.error(`After editing ${relPath}:\n${findings.join('\n')}`)
  process.exit(2)
}

process.exit(0)
