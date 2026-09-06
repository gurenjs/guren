#!/usr/bin/env bun
/**
 * Cursor `stop` hook: when a completed turn ends with uncommitted changes in this
 * app, run `guren gate` (the CI stages: codegen, typecheck, lint, check, audit,
 * test) and hand the findings back as a `followup_message`, which Cursor submits
 * as the next user message, so the fix happens in this conversation rather than
 * in CI. A clean tree is not gated, so a turn that ends by committing is not
 * gated here: run `guren gate` before committing.
 *
 * Bounded twice: `loop_count` here (Cursor counts this hook's follow-ups per
 * conversation) and `loop_limit` in .cursor/hooks.json, which is user-owned.
 * The app root is this script's grandparent (`<app>/.cursor/hooks/`).
 */
import { resolve } from 'node:path'

/** Follow-ups this hook may trigger per conversation. */
const MAX_FOLLOW_UPS = 3

interface HookInput {
  status?: 'completed' | 'aborted' | 'error'
  loop_count?: number
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
if (input.status !== 'completed' || (input.loop_count ?? 0) >= MAX_FOLLOW_UPS) {
  process.exit(0)
}

let cli: typeof import('@guren/cli')
try {
  cli = await import('@guren/cli')
} catch {
  // An unrunnable gate is not a passed one.
  followUp('guren gate could not run: @guren/cli is not resolvable from this app (run `bun install`).')
}

const findings = await cli.stopGateFindings(resolve(import.meta.dir, '../..'))
if (findings === null) {
  process.exit(0)
}
followUp(findings)
