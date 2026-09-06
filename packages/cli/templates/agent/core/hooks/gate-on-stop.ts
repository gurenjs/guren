#!/usr/bin/env bun
/**
 * Stop hook (Claude Code and Codex share this contract): when the agent ends a
 * turn with uncommitted changes in this app, run `guren gate` (the CI stages:
 * codegen, typecheck, lint, check, audit, test) and block the stop with the
 * findings (exit 2, stderr), so the fix happens in this turn rather than in CI.
 * A clean tree is not gated, so a turn that ends by committing is not gated
 * here: run `guren gate` before committing.
 *
 * The app root is this script's grandparent (`<app>/.claude/hooks/`,
 * `<app>/.codex/hooks/`): Codex runs hooks in the session cwd, which may be a
 * subdirectory, and a monorepo app is not the git root.
 */
import { resolve } from 'node:path'

interface HookInput {
  /** Sent by every host speaking this contract; `true` once a Stop hook already blocked this stop. */
  stop_hook_active?: boolean
}

let input: HookInput
try {
  input = JSON.parse(await Bun.stdin.text()) as HookInput
} catch {
  process.exit(0)
}
// A host that does not send the field loaded this config as a foreign one and
// would be gated on every stop: Cursor reads .claude/settings.json hooks too, and
// its own hook in .cursor/hooks.json owns the turn there.
if (typeof input.stop_hook_active !== 'boolean' || input.stop_hook_active) {
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

const findings = await cli.stopGateFindings(resolve(import.meta.dir, '../..'))
if (findings === null) {
  process.exit(0)
}
console.error(findings)
process.exit(2)
