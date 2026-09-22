/**
 * `guren check --plan` (RFC 0030 §8): approved plans with `drifted` elements, and two open
 * plans that change the same application target. Advisory throughout, so `check --ci` and
 * `guren gate` never count it. Content-activated: an app with no plan file reads nothing
 * else, and the application (routes file, `db/schema.ts`) is loaded only for an open plan.
 */

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { CheckResult } from './check-result'
import { toPosixRelative } from './discovery'
import type { PlanAppState } from './plan/app-state'
import type { PlanAppTarget } from './plan/app-targets'
import type { Plan } from './plan/schema'

/** Where plans are found: `docs/plans/**` (the §9 layout and `<slug>.plan.json`) and the app root's own `*.plan.json`. */
export const PLAN_DIR = 'docs/plans'

/** A plan file by name; the records beside one (`approvals.json`, `<slug>.decisions.json`) never match. */
export function isPlanFileName(name: string): boolean {
  return name === 'plan.json' || name.endsWith('.plan.json')
}

async function entries(dir: string): Promise<import('node:fs').Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') return []
    throw error
  }
}

/** Absolute paths, sorted. `revisions/` is skipped: it holds a plan's revision documents (§9), not plans. */
export async function discoverPlanFiles(appRoot: string): Promise<string[]> {
  const found: string[] = []
  for (const entry of await entries(appRoot)) {
    if (entry.isFile() && entry.name.endsWith('.plan.json')) found.push(join(appRoot, entry.name))
  }
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await entries(dir)) {
      if (entry.isDirectory()) {
        if (entry.name !== 'revisions') await walk(join(dir, entry.name))
      } else if (entry.isFile() && isPlanFileName(entry.name)) {
        found.push(join(dir, entry.name))
      }
    }
  }
  await walk(join(appRoot, PLAN_DIR))
  return found.sort()
}

interface OpenPlan {
  path: string
  file: string
  read: { path: string; plan: Plan }
}

type Classified = { kind: 'open'; plan: OpenPlan } | { kind: 'closed' | 'unapproved' | 'draft' } | { kind: 'unreadable'; reason: string }

/**
 * Closed is what `plan:close` writes: `closed: true` in `docs/plans/<slug>.md`, at the hash
 * the plan has now. A revision approved after the close is open work again.
 */
async function isClosed(appRoot: string, slug: string, hash: string): Promise<boolean | string> {
  const { planDocPath } = await import('./plan/close-docs')
  const { parseDocFrontmatter } = await import('./docs-frontmatter')
  const path = join(appRoot, planDocPath(slug))
  let source: string
  try {
    source = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    return `${toPosixRelative(appRoot, path)} could not be read: ${(error as Error).message}`
  }
  // The frontmatter reader returns scalars as strings, so `closed: true` reads as 'true'.
  const data = parseDocFrontmatter(source)?.data
  return data?.closed === 'true' && data.plan_hash === hash
}

async function classify(appRoot: string, path: string): Promise<Classified> {
  const [{ readPlanFile }, { hasBaseline }, { planHash }, { readPlanApprovals }, { planSlug }] = await Promise.all([
    import('./plan-render'),
    import('./plan/render'),
    import('./plan/identity'),
    import('./plan/approvals'),
    import('./plan/state'),
  ])
  let read: Awaited<ReturnType<typeof readPlanFile>>
  try {
    read = await readPlanFile(path, appRoot)
  } catch (error) {
    return { kind: 'unreadable', reason: (error as Error).message }
  }
  const plan = read.plan
  if (!hasBaseline(plan)) return { kind: 'draft' }
  const approvals = await readPlanApprovals(read.path)
  if (approvals.unreadable) return { kind: 'unreadable', reason: approvals.unreadable }
  const hash = planHash(plan)
  if (!approvals.value?.approvals.some((approval) => approval.hash === hash)) return { kind: 'unapproved' }
  const closed = await isClosed(appRoot, planSlug(read.path), hash)
  if (typeof closed === 'string') return { kind: 'unreadable', reason: closed }
  if (closed) return { kind: 'closed' }
  return { kind: 'open', plan: { path: read.path, file: toPosixRelative(appRoot, read.path), read: { path: read.path, plan } } }
}

/**
 * The names a target occupies in the application. A rename occupies both of its names, a
 * column is qualified by the table it is looked up in, and a route also by its endpoint.
 */
export function targetKeys(target: PlanAppTarget): Array<{ key: string; label: string }> {
  const root = target.perRoot ? (target.module ?? '') : ''
  const names = [target.current, ...(target.previous !== undefined && target.previous !== target.current ? [target.previous] : [])]
  const keys = names.map((name) => {
    const qualified = target.table ? `${target.table.lookup}.${name}` : name
    return { key: `${target.appSection}|${root}|${qualified}`, label: `${target.noun} ${qualified}${root ? ` (module ${root})` : ''}` }
  })
  if (target.endpoint) keys.push({ key: `endpoint|${target.endpoint}`, label: `endpoint ${target.endpoint}` })
  return keys
}

/** What two open plans both change. An `existing` target is only read, which two plans may share. */
async function collisions(plans: readonly OpenPlan[]): Promise<CheckResult[]> {
  const { listPlanAppTargets } = await import('./plan/app-targets')
  const owners = new Map<string, { label: string; plans: Map<string, string[]> }>()
  for (const plan of plans) {
    for (const target of listPlanAppTargets(plan.read.plan)) {
      if (target.kind === 'existing') continue
      for (const { key, label } of targetKeys(target)) {
        const entry = owners.get(key) ?? { label, plans: new Map<string, string[]>() }
        const ids = entry.plans.get(plan.file) ?? []
        if (!ids.includes(target.id)) ids.push(target.id)
        entry.plans.set(plan.file, ids)
        owners.set(key, entry)
      }
    }
  }

  const byPair = new Map<string, { files: [string, string]; shared: string[] }>()
  for (const { label, plans: holders } of owners.values()) {
    const files = [...holders.keys()].sort()
    for (let i = 0; i < files.length; i += 1) {
      for (let j = i + 1; j < files.length; j += 1) {
        const pair: [string, string] = [files[i], files[j]]
        const entry = byPair.get(pair.join('|')) ?? { files: pair, shared: [] }
        entry.shared.push(`${label} (${holders.get(pair[0])!.join(', ')} / ${holders.get(pair[1])!.join(', ')})`)
        byPair.set(pair.join('|'), entry)
      }
    }
  }

  return [...byPair.values()].map(({ files: [a, b], shared }) => ({
    key: `plan:overlap:${a}:${b}`,
    title: 'Open plans overlap',
    status: 'warn',
    message: `${a} and ${b} are both approved and open, and both change: ${shared.sort().join('; ')}.`,
    suggestion: 'Land or close one plan before implementing the other, or revise one so they stop changing the same element.',
    filePath: a,
    advisory: true,
  }))
}

export interface PlanCheckOptions {
  cwd: string
  routesFile?: string
}

export async function checkPlans(options: PlanCheckOptions): Promise<CheckResult[]> {
  const appRoot = options.cwd
  const files = await discoverPlanFiles(appRoot)
  if (files.length === 0) return []

  const results: CheckResult[] = []
  const open: OpenPlan[] = []
  for (const path of files) {
    const classified = await classify(appRoot, path)
    const file = toPosixRelative(appRoot, path)
    if (classified.kind === 'open') open.push(classified.plan)
    else if (classified.kind === 'unreadable') {
      results.push({
        key: `plan:unreadable:${file}`,
        title: 'Plan not read',
        status: 'warn',
        message: `${file} was not checked: ${classified.reason}`,
        suggestion: 'Fix the file so guren plan:status can read it.',
        filePath: file,
        advisory: true,
      })
    }
  }

  if (open.length > 0) {
    const [{ planStatusFile }, { loadPlanAppState }] = await Promise.all([import('./plan-status'), import('./plan/app-state')])
    let app: Promise<PlanAppState> | undefined
    const loadApp = (): Promise<PlanAppState> => (app ??= loadPlanAppState(appRoot, { detail: true, routesFile: options.routesFile }))
    for (const plan of open) {
      let drifted: string[]
      try {
        const report = await planStatusFile(plan.path, { app: loadApp, appRoot, read: plan.read })
        drifted = report.elements.filter((element) => element.state === 'drifted').map((element) => element.id)
      } catch (error) {
        results.push({
          key: `plan:unreadable:${plan.file}`,
          title: 'Plan not read',
          status: 'warn',
          message: `${plan.file} was not judged: ${(error as Error).message}`,
          suggestion: `Run guren plan:status ${plan.file} to see the failure.`,
          filePath: plan.file,
          advisory: true,
        })
        continue
      }
      if (drifted.length === 0) continue
      results.push({
        key: `plan:drifted:${plan.file}`,
        title: 'Approved plan drifted',
        status: 'warn',
        message: `${plan.file} has ${drifted.length} drifted element(s): ${drifted.join(', ')}.`,
        suggestion: `Run guren plan:status ${plan.file} for what differs, then fix the code or revise the plan.`,
        filePath: plan.file,
        advisory: true,
      })
    }
    results.push(...(await collisions(open)))
  }

  return results
}
