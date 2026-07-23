#!/usr/bin/env bun
/**
 * PostToolUse hook: after an agent edits routes, controllers, models, schema,
 * or pages, run `guren check` and feed failures back so they get fixed
 * immediately instead of surfacing later in CI.
 *
 * Exit codes: 0 = ok / not applicable, 2 = failures reported back to the agent.
 */
import { relative } from 'node:path'

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

let filePath = ''
try {
  const input = JSON.parse(await Bun.stdin.text()) as HookInput
  filePath = input.tool_input?.file_path ?? ''
} catch {
  process.exit(0)
}

const relPath = relative(process.cwd(), filePath)
if (!WATCHED_PATHS.some((prefix) => relPath.startsWith(prefix))) {
  process.exit(0)
}

// Run the check in-process: this hook fires on every watched edit, and
// spawning bunx + the CLI would cost a few hundred ms per edit. `changed:
// true` restricts file-scanning checks (empty methods, architecture
// boundaries) to what's actually changed, so this stays fast as the app
// grows — it falls back to checking everything outside a git repo.
let report
try {
  const { runCheck } = await import('@guren/cli')
  report = await runCheck({ changed: true })
} catch {
  process.exit(0)
}

if (report.failCount > 0) {
  const failures = report.checks.filter((check) => check.status === 'fail')
  const lines = failures.map((check) => {
    const location = check.filePath ? ` [${check.filePath}]` : ''
    const suggestion = check.suggestion ? ` → ${check.suggestion}` : ''
    return `- ${check.title}: ${check.message}${location}${suggestion}`
  })
  console.error(
    `guren check found ${report.failCount} issue(s) after editing ${relPath}:\n${lines.join('\n')}`,
  )
  process.exit(2)
}

process.exit(0)
