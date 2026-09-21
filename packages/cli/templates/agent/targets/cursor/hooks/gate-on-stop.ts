#!/usr/bin/env bun
/**
 * Cursor `stop` hook: when a completed turn ends with uncommitted changes in this
 * app, run `guren gate` (the CI stages: codegen, typecheck, lint, check, audit,
 * test) and hand the findings back as a `followup_message`, which Cursor submits
 * as the next user message, so the fix happens in this conversation rather than
 * in CI. Then, while `guren plan:next` has marked a plan step, verify it and follow
 * up until it is verified or the hook gives up (RFC 0030 §7), which it says on stderr.
 */
import { resolve } from 'node:path'

/**
 * Follow-ups this hook may trigger per conversation. Bounded twice: here, and by
 * `loop_limit` in .cursor/hooks.json, which is user-owned.
 */
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
const loopCount = input.loop_count ?? 0
if (input.status !== 'completed' || loopCount >= MAX_FOLLOW_UPS) {
  process.exit(0)
}

let cli: typeof import('@guren/cli')
try {
  cli = await import('@guren/cli')
} catch {
  // An unrunnable gate is not a passed one.
  followUp('guren gate could not run: @guren/cli is not resolvable from this app (run `bun install`).')
}

// The app root is this script's grandparent (`<app>/.cursor/hooks/`).
const root = resolve(import.meta.dir, '../..')
const findings = await cli.stopGateFindings(root)
// null when the tree is clean, so a turn that ends by committing is not gated
// here: run `guren gate` before committing.
if (findings !== null) {
  followUp(findings)
}

const plan = await cli.planStopHookFindings(root, { stopHookActive: loopCount > 0 })
if (plan.block && plan.message) {
  followUp(plan.message)
}
if (plan.message) {
  console.error(plan.message)
}
process.exit(0)
