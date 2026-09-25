#!/usr/bin/env bun
/**
 * PostToolUse hook: after an agent edits a file, run `guren check` (for routes,
 * controllers, models, schema, and pages) and oxlint (for any source file, when
 * the app has an .oxlintrc.json) and feed findings back so they get fixed
 * immediately instead of surfacing later in CI.
 */
import { existsSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

interface HookInput {
  /** The session's cwd, which follows the agent's `cd` and a worktree it entered. */
  cwd?: string
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

let input: HookInput
try {
  input = JSON.parse(await Bun.stdin.text()) as HookInput
} catch {
  process.exit(0)
}
const filePath = input.tool_input?.file_path ?? ''
if (filePath === '') {
  process.exit(0)
}

/**
 * The app to check: the nearest ancestor of the session cwd holding this script at
 * its own path, else the script's grandparent (`<app>/.claude/hooks/`). The same
 * rule as `gate-on-stop.ts`: the cwd follows the agent's `cd` into a subdirectory
 * or a worktree, and every path below is judged from the app root, never the cwd.
 */
function appRoot(cwd: unknown): string {
  const installed = resolve(import.meta.dir, '../..')
  const self = relative(installed, import.meta.path)
  if (typeof cwd === 'string' && isAbsolute(cwd)) {
    for (let dir = cwd; ; dir = dirname(dir)) {
      if (existsSync(join(dir, self))) return dir
      if (dirname(dir) === dir) break
    }
  }
  return installed
}
const root = appRoot(input.cwd)

/** Both sides resolved: on macOS a temp dir's real path is `/private/var/...` while the editor hands over `/var/...`. */
function real(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

// POSIX separators so the prefix lists below match on Windows too; `relative()`
// yields an absolute path across drives there, which is outside the project.
const relPath = relative(real(root), real(resolve(filePath))).split(sep).join('/')
if (relPath === '' || isAbsolute(relPath) || relPath === '..' || relPath.startsWith('../')) {
  process.exit(0)
}

const wantsCheck = WATCHED_PATHS.some((prefix) => relPath.startsWith(prefix))
const wantsLint = existsSync(join(root, '.oxlintrc.json'))
if (!wantsCheck && !wantsLint) {
  process.exit(0)
}

// In-process: this hook fires on every watched edit, and spawning bunx + the
// CLI would cost a few hundred ms per edit.
let cli: typeof import('@guren/cli')
try {
  cli = await import('@guren/cli')
} catch {
  // An unrunnable check is not a passed one.
  console.error('guren check could not run: @guren/cli is not resolvable from this app (run `bun install`).')
  process.exit(2)
}

const findings: string[] = []

if (wantsCheck) {
  // `changed: true` restricts file-scanning checks to what's actually changed,
  // so this stays fast as the app grows; it checks everything outside a git repo.
  // Same rule as `check --ci` and `guren gate`: warns count, advisory checks do not.
  const gating = cli.gatingResults(await cli.runCheck({ cwd: root, changed: true }))
  if (gating.length > 0) {
    findings.push(`guren check found ${gating.length} issue(s):`)
    findings.push(...gating.map((check) => `- ${cli.formatFinding(check)}`))
  }
}

// Warnings are reported too: the comment rules are warnings so `bun run lint`
// stays green, and the agent that just wrote the comment is the one who can fix it.
if (wantsLint && cli.isLintable(relPath)) {
  const run = await cli.runOxlint(root, [relPath])
  if (run.kind === 'not-installed') {
    findings.push('.oxlintrc.json is present but oxlint is not installed: run `bun install`')
  } else {
    const lines = run.findings.filter((line) => line.startsWith(`${relPath}:`))
    if (lines.length > 0) {
      findings.push(`oxlint found ${lines.length} issue(s):`)
      findings.push(...lines.map((line) => `- ${line}`))
    } else if (run.exitCode !== 0) {
      // A config or plugin-load failure has no file prefix; it must not read as clean.
      findings.push(`oxlint exited ${run.exitCode} without linting ${relPath}:\n${run.output}`)
    }
  }
}

// Exit 2 is what carries the findings back to the agent; 0 is ok or not applicable.
if (findings.length > 0) {
  console.error(`After editing ${relPath}:\n${findings.join('\n')}`)
  process.exit(2)
}

process.exit(0)
