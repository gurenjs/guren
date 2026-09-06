#!/usr/bin/env bun
/**
 * Cursor `stop` hook: when the agent ends a turn with uncommitted changes, run
 * `guren gate` (the CI stages: codegen, typecheck, lint, check, audit, test) and
 * hand the findings back as a `followup_message`, which Cursor submits as the
 * next user message, so the fix happens in this conversation rather than in CI.
 *
 * Bounded by `loop_limit` in .cursor/hooks.json (Cursor counts the follow-ups
 * this hook triggers per conversation). A clean working tree is not gated,
 * which also means a turn that ends by committing is not gated here: run
 * `guren gate` before committing. Only a completed turn is gated.
 */

// A module, so the top-level awaits below typecheck.
export {}

interface HookInput {
  status?: 'completed' | 'aborted' | 'error'
}

function followUp(message: string): never {
  console.log(JSON.stringify({ followup_message: message }))
  process.exit(0)
}

let input: HookInput
try {
  input = JSON.parse(await Bun.stdin.text()) as HookInput
} catch {
  process.exit(0)
}
if (input.status !== 'completed') {
  process.exit(0)
}

let cli: typeof import('@guren/cli')
try {
  cli = await import('@guren/cli')
} catch {
  // An unrunnable gate is not a passed one.
  followUp('guren gate could not run: @guren/cli is not resolvable from this app (run `bun install`).')
}

const findings = await cli.stopGateFindings()
if (findings === null) {
  process.exit(0)
}
followUp(`${findings}\nFix these, then run \`bunx guren gate\` until it exits 0.`)
