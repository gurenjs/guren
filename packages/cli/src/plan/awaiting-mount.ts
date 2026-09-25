/**
 * The routes files a scaffold step wrote for an open plan and its http step has not mounted yet
 * (RFC 0030 §5, D3): `guren check` reports such a file as advisory rather than as an unmounted
 * registrar, so the gate does not block the steps between the scaffold and the http step. Reads
 * the plan files, their approvals, the closing documents and the state files only: never
 * `db/schema.ts`, a validator file or `planStatusFile()`, which plain `check` must not pay for.
 * Anything that will not read leaves its files out, so the warning stands.
 */

import { readFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'

import { discoverPlanFiles } from '../plan-check'
import { readPlanFile } from '../plan-render'
import { readPlanApprovalStanding } from './approvals'
import { planDocClosedHash, planDocPath } from './close-docs'
import { planDigest } from './identity'
import { planScaffoldMounts } from './scaffold'
import { planSlug, readPlanState } from './state'
import { derivePlanTasks } from './tasks'

export interface ScaffoldAwaitingMount {
  /** The plan file, app-relative with POSIX separators. */
  plan: string
  /** The http step that mounts the file; undefined where no http step holds its routes. */
  step: string | undefined
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
  const { plan } = await readPlanFile(path, appRoot)
  const standing = await readPlanApprovalStanding(path, plan)
  if (standing?.state !== 'approved') return []
  const slug = planSlug(path)
  let closing: string | undefined
  try {
    closing = await readFile(join(appRoot, planDocPath(slug)), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return []
  }
  if (closing !== undefined && planDocClosedHash(closing) === standing.hash) return []
  const state = await readPlanState(appRoot, slug)
  if (state.unreadable) return []
  const digest = planDigest(plan)
  const file = relative(appRoot, path).split(sep).join('/')
  return planScaffoldMounts(plan, derivePlanTasks(plan)).flatMap((mount): Array<[string, ScaffoldAwaitingMount]> => {
    const record = mount.httpStep ? state.state?.steps[mount.httpStep] : undefined
    if (record?.outcome === 'verified' && record.planDigest === digest) return []
    return [[mount.path, { plan: file, step: mount.httpStep, registrar: mount.registrar }]]
  })
}
