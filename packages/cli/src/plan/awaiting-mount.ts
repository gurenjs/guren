/**
 * The routes files a scaffold step wrote for an open plan and its http step has not mounted yet
 * (RFC 0030 §5, D3): `guren check` reports such a file as advisory rather than as an unmounted
 * registrar, so the gate does not block the steps between the scaffold and the http step. Reads
 * the plan files, their approvals, the closing documents and the state files only: never
 * `db/schema.ts`, a validator file or `planStatusFile()`, which plain `check` must not pay for.
 * Anything that will not read leaves its files out, so the warning stands.
 */

import { discoverPlanFiles } from '../plan-check'
import { planDigest } from './identity'
import { readOpenPlan } from './open-plan'
import { planScaffoldMountCommandLine, planScaffoldMounts } from './scaffold'
import { planSlug, readPlanState } from './state'
import { derivePlanTasks } from './tasks'

export interface ScaffoldAwaitingMount {
  /** The plan file, app-relative with POSIX separators. */
  plan: string
  /** The http step that mounts the file, and the command it runs. */
  step: string
  command: string
  registrar: string
}

/** By app-relative routes file: each one an approved, unclosed plan's scaffold writes and whose http step has no verified record at the plan's digest. */
export async function scaffoldedRoutesAwaitingMount(appRoot: string): Promise<Map<string, ScaffoldAwaitingMount>> {
  const awaiting = new Map<string, ScaffoldAwaitingMount>()
  for (const path of (await discoverPlanFiles(appRoot)).files) {
    const read = await awaitingIn(appRoot, path).catch(() => [])
    for (const [file, entry] of read) if (!awaiting.has(file)) awaiting.set(file, entry)
  }
  return awaiting
}

async function awaitingIn(appRoot: string, path: string): Promise<Array<[string, ScaffoldAwaitingMount]>> {
  const reading = await readOpenPlan(appRoot, path)
  if (reading.kind !== 'open') return []
  const { plan, file } = reading.plan
  const state = await readPlanState(appRoot, planSlug(path))
  if (state.unreadable) return []
  const digest = planDigest(plan)
  return planScaffoldMounts(plan, derivePlanTasks(plan)).flatMap((mount): Array<[string, ScaffoldAwaitingMount]> => {
    const record = state.state?.steps[mount.httpStep]
    if (record?.outcome === 'verified' && record.planDigest === digest) return []
    return [[mount.path, { plan: file, step: mount.httpStep, command: planScaffoldMountCommandLine(file, mount.httpStep), registrar: mount.registrar }]]
  })
}
