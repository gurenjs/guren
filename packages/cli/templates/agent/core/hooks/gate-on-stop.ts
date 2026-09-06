#!/usr/bin/env bun
/**
 * Stop hook (Claude Code and Codex share this contract): when the agent ends a
 * turn with uncommitted changes, run `guren gate` (the CI stages: codegen,
 * typecheck, lint, check, audit, test) and block the stop with the findings, so
 * the fix happens in this turn rather than in CI.
 *
 * Two guards keep it from blocking forever: `stop_hook_active` (set when a Stop
 * hook already blocked this stop, so the gate fires once per stop) and a clean
 * working tree, which also means a turn that ends by committing is not gated
 * here: run `guren gate` before committing. Exit codes: 0 = allow, 2 = block.
 *
 * The app root is the first argument when given (Codex runs hooks in the session
 * cwd, which may be a subdirectory, so its hooks.json passes the git root), else cwd.
 */

// A module, so the top-level awaits below typecheck.
export {}

interface HookInput {
  stop_hook_active?: boolean
  /** Present when Cursor runs this hook through its Claude Code compatibility. */
  cursor_version?: string
}

let input: HookInput
try {
  input = JSON.parse(await Bun.stdin.text()) as HookInput
} catch {
  process.exit(0)
}
if (input.stop_hook_active) {
  process.exit(0)
}
// Cursor can load .claude/settings.json hooks too (an opt-in setting). It never
// sets stop_hook_active, so this script would gate every stop; its own hook in
// .cursor/hooks.json owns the turn there.
if (input.cursor_version) {
  process.exit(0)
}

let cli: typeof import('@guren/cli')
try {
  cli = await import('@guren/cli')
} catch {
  // An unrunnable gate is not a passed one.
  console.error('guren gate could not run: @guren/cli is not resolvable from this app (run `bun install`).')
  process.exit(2)
}

const findings = await cli.stopGateFindings(process.argv[2] || process.cwd())
if (findings === null) {
  process.exit(0)
}
console.error(findings)
process.exit(2)
