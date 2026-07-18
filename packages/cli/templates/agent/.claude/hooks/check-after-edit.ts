#!/usr/bin/env bun
/**
 * PostToolUse hook: after an agent edits routes, controllers, models, schema,
 * or pages, run `guren check` and feed failures back so they get fixed
 * immediately instead of surfacing later in CI.
 *
 * Exit codes: 0 = ok / not applicable, 2 = failures reported back to the agent.
 */

interface HookInput {
  tool_input?: {
    file_path?: string
  }
}

interface CheckResult {
  status: 'pass' | 'warn' | 'fail'
  title: string
  message: string
  suggestion?: string
  filePath?: string
}

interface CheckReport {
  checks: CheckResult[]
  failCount: number
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

const relPath = filePath.startsWith(`${process.cwd()}/`)
  ? filePath.slice(process.cwd().length + 1)
  : filePath

if (!WATCHED_PATHS.some((prefix) => relPath.startsWith(prefix))) {
  process.exit(0)
}

const result = Bun.spawnSync(['bunx', 'guren', 'check', '--json'], {
  stdout: 'pipe',
  stderr: 'pipe',
})

const stdout = result.stdout.toString()
const start = stdout.indexOf('{')
const end = stdout.lastIndexOf('}')
if (start === -1 || end === -1) {
  process.exit(0)
}

let report: CheckReport
try {
  report = JSON.parse(stdout.slice(start, end + 1)) as CheckReport
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
