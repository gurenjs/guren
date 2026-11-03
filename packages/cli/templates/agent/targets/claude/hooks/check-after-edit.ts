#!/usr/bin/env bun
/**
 * PostToolUse hook: after an agent edits a file, run `guren check` (for routes,
 * controllers, models, schema, and pages) and oxlint (for any source file, when
 * the app has an .oxlintrc.json), and hand the findings to the agent as context
 * beside the edit's result. It never blocks: a change spanning several files passes
 * through states these checks flag, and the Stop hook's `guren gate` is what blocks.
 * A file git ignores is skipped.
 */
import { existsSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

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

/**
 * Claude Code passes at most 10,000 characters of `additionalContext` inline; past that the
 * agent gets a file path and a 2,000-character preview it is not asked to open.
 */
const CONTEXT_LIMIT = 9_000

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
 * The app to check: the nearest ancestor of the edited file holding this script at its
 * own path, else the script's grandparent (`<app>/.claude/hooks/`). The command runs the
 * project dir's copy while the file may sit in a worktree Claude entered, and every path
 * below is judged from the app root, never from the cwd, which follows the agent's `cd`.
 */
function appRoot(file: string): string {
  const installed = resolve(import.meta.dir, '../..')
  const self = relative(installed, import.meta.path)
  for (let dir = dirname(file); ; dir = dirname(dir)) {
    if (existsSync(join(dir, self))) return dir
    if (dirname(dir) === dir) return installed
  }
}
const editedFile = resolve(filePath)
const root = appRoot(editedFile)

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
const relPath = relative(real(root), real(editedFile)).split(sep).join('/')
if (relPath === '' || isAbsolute(relPath) || relPath === '..' || relPath.startsWith('../')) {
  process.exit(0)
}

/** `git check-ignore` exits 0 for an ignored path, 1 for one that is not, and 128 outside a repository. */
function gitIgnores(path: string): boolean {
  try {
    return Bun.spawnSync(['git', 'check-ignore', '-q', '--', path], { cwd: root, stdout: 'ignore', stderr: 'ignore' }).exitCode === 0
  } catch {
    // No git on PATH: nothing says the file is ignored.
    return false
  }
}
if (gitIgnores(relPath)) {
  process.exit(0)
}

const wantsCheck = WATCHED_PATHS.some((prefix) => relPath.startsWith(prefix))
const wantsLint = existsSync(join(root, '.oxlintrc.json'))
if (!wantsCheck && !wantsLint) {
  process.exit(0)
}

// Claude Code reads stdout as this hook's JSON only when nothing else is on it, and the
// checks run consola and app code in this process. Bun's console.log bypasses stdout.write.
const writeStdout = process.stdout.write.bind(process.stdout)
process.stdout.write = process.stderr.write.bind(process.stderr) as typeof process.stdout.write
console.log = console.info = console.debug = console.error

/**
 * Always exit 0 after this: exit 2 would show the findings as a hook error, and a PostToolUse
 * hook cannot undo the edit anyway. Bun's process.exit() drops stdout still queued on a pipe,
 * so this resolves only once the write's callback says it reached the OS.
 */
async function report(findings: string[]): Promise<void> {
  if (findings.length === 0) return
  let text = findings.join('\n')
  if (text.length > CONTEXT_LIMIT) {
    const cut = text.lastIndexOf('\n', CONTEXT_LIMIT)
    text = `${text.slice(0, cut > 0 ? cut : CONTEXT_LIMIT)}\n(The list is cut here; \`bunx guren check --changed\` and oxlint print all of it.)`
  }
  const additionalContext = `After editing ${relPath}:\n${text}\n`
    + 'These findings do not block the edit: a change that spans several files passes through states they flag.'
    + ' The Stop hook runs `guren gate` on the finished change, and that is what has to pass.'
  const payload = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext } })
  await new Promise<void>((done) => writeStdout(`${payload}\n`, () => done()))
}

// In-process: this hook fires on every watched edit, and spawning bunx + the
// CLI would cost a few hundred ms per edit.
let cli: typeof import('@guren/cli')
try {
  cli = await import('@guren/cli')
} catch {
  // An unrunnable check is not a passed one.
  await report(['guren check could not run: @guren/cli is not resolvable from this app (run `bun install`).'])
  process.exit(0)
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

await report(findings)
process.exit(0)
