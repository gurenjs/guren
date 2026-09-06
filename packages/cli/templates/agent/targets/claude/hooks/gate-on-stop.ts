#!/usr/bin/env bun
/**
 * Stop hook: when the agent ends a turn with uncommitted changes, run `guren gate`
 * (the CI stages: codegen, typecheck, lint, check, audit, test) and block the stop
 * with the findings, so the fix happens in this turn rather than in CI.
 *
 * Two guards keep it from blocking forever: `stop_hook_active` (Claude Code sets
 * it when a Stop hook already blocked this stop, so the gate fires once per stop)
 * and a clean working tree, which also means a turn that ends by committing is not
 * gated here: run `guren gate` before committing. Exit codes: 0 = allow, 2 = block.
 */

// A module, so the top-level awaits below typecheck.
export {}

interface HookInput {
  stop_hook_active?: boolean
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

// Outside a git repository the tree cannot be judged clean, so the gate runs.
const tree = Bun.spawnSync(['git', 'status', '--porcelain'], { stdout: 'pipe', stderr: 'pipe' })
if (tree.exitCode === 0 && tree.stdout.toString().trim() === '') {
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

// `--changed`: check and lint on what this session touched; typecheck, audit, and
// the tests answer for the whole app either way.
const report = await cli.runGate({ changed: true })
if (report.ok) {
  process.exit(0)
}

console.error(`${cli.describeGateFailures(report)}\nRun \`bunx guren gate\` to see every stage.`)
process.exit(2)
