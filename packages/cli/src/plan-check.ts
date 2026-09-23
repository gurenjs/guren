/**
 * `guren check --plan` (RFC 0030 §8): approved plans with `drifted` elements or a command the
 * allowlist refuses, and two open plans that change the same application target. Advisory throughout, so it never sets an
 * exit code, and it runs only under `--plan`: judging a plan imports `db/schema.ts` and every
 * validator file, which plain `check` never does. An app with no plan file reads nothing else.
 */

import type { Dirent } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join, posix, sep } from 'node:path'

import type { CheckResult } from './check-result'
import { toPosixRelative } from './discovery'
import type { PlanAppState } from './plan/app-state'
import type { PlanAppTarget } from './plan/app-targets'
import type { planSiblingPath } from './plan/beside'
import type { Plan } from './plan/schema'

/** Where plans are found: `docs/plans/**` (the §9 layout and `<slug>.plan.json`) and the app root's own `*.plan.json`. */
export const PLAN_DIR = 'docs/plans'

const PLAN_RECORDS: ReadonlyArray<Parameters<typeof planSiblingPath>[1]> = ['approvals', 'decisions']

/** A plan file by name; the records beside one (`approvals.json`, `<slug>.decisions.json`) never match. */
export function isPlanFileName(name: string): boolean {
  return name === 'plan.json' || name.endsWith('.plan.json')
}

/** Whether a change to this app-relative POSIX path can move a finding: a plan, a record beside one, or anything under `docs/plans/`. */
export function isPlanInput(file: string): boolean {
  if (file.startsWith(`${PLAN_DIR}/`)) return true
  const name = posix.basename(file)
  return isPlanFileName(name) || PLAN_RECORDS.some((record) => name.endsWith(`.${record}.json`))
}

export interface PlanDiscovery {
  /** Absolute paths, sorted. */
  files: string[]
  /** Directories that exist and would not list, with why; a plan in one is not checked. */
  unreadable: Array<{ dir: string; reason: string }>
}

/** `revisions/` is skipped: it holds a plan's revision documents (§9), not plans. */
export async function discoverPlanFiles(appRoot: string): Promise<PlanDiscovery> {
  const discovery: PlanDiscovery = { files: [], unreadable: [] }
  const entries = async (dir: string): Promise<Dirent[]> => {
    try {
      return await readdir(dir, { withFileTypes: true })
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') discovery.unreadable.push({ dir, reason: (error as Error).message })
      return []
    }
  }
  // A bare `plan.json` at the root would take the app directory's name as its slug.
  for (const entry of await entries(appRoot)) {
    if (entry.isFile() && entry.name !== 'plan.json' && isPlanFileName(entry.name)) discovery.files.push(join(appRoot, entry.name))
  }
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await entries(dir)) {
      if (entry.isDirectory()) {
        if (entry.name !== 'revisions') await walk(join(dir, entry.name))
      } else if (entry.isFile() && isPlanFileName(entry.name)) {
        discovery.files.push(join(dir, entry.name))
      }
    }
  }
  await walk(join(appRoot, PLAN_DIR))
  discovery.files.sort()
  return discovery
}

async function loadModules() {
  const [render, approvals, state, closeDocs, targets, status, appState, allowlist] = await Promise.all([
    import('./plan-render'),
    import('./plan/approvals'),
    import('./plan/state'),
    import('./plan/close-docs'),
    import('./plan/app-targets'),
    import('./plan-status'),
    import('./plan/app-state'),
    import('./plan/command-allowlist'),
  ])
  return {
    readPlanFile: render.readPlanFile,
    readPlanApprovalStanding: approvals.readPlanApprovalStanding,
    describeUnapproved: approvals.describeUnapproved,
    planSlug: state.planSlug,
    planDocPath: closeDocs.planDocPath,
    planDocClosedHash: closeDocs.planDocClosedHash,
    listPlanAppTargets: targets.listPlanAppTargets,
    planStatusFile: status.planStatusFile,
    loadPlanAppState: appState.loadPlanAppState,
    judgePlanCommand: allowlist.judgePlanCommand,
  }
}

type Modules = Awaited<ReturnType<typeof loadModules>>

interface OpenPlan {
  path: string
  file: string
  plan: Plan
}

/**
 * Skipped: a draft nobody approved, a plan changed since its approval, or one `plan:close` closed
 * at its current hash. A draft with approvals beside it lost its baseline, which is reported.
 */
type Classified = { kind: 'open'; plan: OpenPlan } | { kind: 'skipped' } | { kind: 'unreadable' | 'baseline-removed'; reason: string }

async function classify(m: Modules, appRoot: string, path: string, file: string): Promise<Classified> {
  let plan: Awaited<ReturnType<Modules['readPlanFile']>>['plan']
  try {
    plan = (await m.readPlanFile(path, appRoot)).plan
  } catch (error) {
    return { kind: 'unreadable', reason: (error as Error).message }
  }
  // The approval rule every gated plan command reads (RFC 0030 §4), so the two cannot disagree.
  const standing = await m.readPlanApprovalStanding(path, plan)
  if (standing === undefined || standing.state === 'unapproved') return { kind: 'skipped' }
  if (standing.state === 'unreadable') return { kind: 'unreadable', reason: standing.reason }
  if (standing.state === 'baseline-removed') return { kind: 'baseline-removed', reason: m.describeUnapproved(file, standing, 'it is not checked') }
  const hash = standing.hash

  const doc = join(appRoot, m.planDocPath(m.planSlug(path)))
  let source: string | undefined
  try {
    source = await readFile(doc, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return { kind: 'unreadable', reason: `${doc} could not be read: ${(error as Error).message}` }
  }
  // A revision approved after the close carries another hash, and is open work again.
  if (source !== undefined && m.planDocClosedHash(source) === hash) return { kind: 'skipped' }
  // Only a plan with a baseline has the hash an `approved` standing names.
  return { kind: 'open', plan: { path, file, plan: plan as Plan } }
}

type ClaimKind = PlanAppTarget['kind'] | 'parent'

interface Claim {
  label: string
  id: string
  kind: ClaimKind
}

/** One SQL table per name whatever the root (validate.ts SHARED_SCHEMA), so tables and their columns are keyed app-wide. */
function rootOf(target: PlanAppTarget): string {
  return target.appSection === 'tables' || !target.perRoot ? '' : (target.module ?? '')
}

function inModule(root: string): string {
  return root ? ` (module ${root})` : ''
}

/**
 * The names a target occupies, by structured key. A rename occupies both of its names, a
 * column is keyed under its table, and a route also by its endpoint. A changed column or
 * action also claims its parent, which collides only with a plan renaming or dropping it; so
 * does a model's `alter` on its table. A class rename never moves the table, which stays `existing`.
 */
function claims(target: PlanAppTarget): Array<[string, Claim]> {
  if (target.kind === 'existing') return []
  const root = rootOf(target)
  const names = [...new Set([target.current, ...(target.previous === undefined ? [] : [target.previous])])]
  const own = (parts: string[], label: string): [string, Claim] => [JSON.stringify(parts), { label, id: target.id, kind: target.kind }]
  const parent = (parts: string[], label: string): [string, Claim] => [JSON.stringify(parts), { label, id: target.id, kind: 'parent' }]

  if (target.table) {
    const { lookup, current } = target.table
    return [
      ...names.map((name) => own(['tables', '', lookup, name], `column ${lookup}.${name}`)),
      ...[...new Set([lookup, current])].map((table) => parent(['tables', '', table], `table ${table}`)),
    ]
  }
  // A model's `alter` names its class, not its table: the columns carry the table-level change.
  const claim = target.appSection === 'tables' && target.kind === 'alter' ? parent : own
  const result = names.map((name) => claim([target.appSection, root, name], `${target.noun} ${name}${inModule(root)}`))
  if (target.endpoint) result.push(own(['endpoint', target.endpoint], `endpoint ${target.endpoint}`))
  if (target.appSection === 'actions') {
    const classes = new Set(names.map((name) => name.slice(0, name.lastIndexOf('.'))))
    if (target.renamedClass) classes.add(target.renamedClass.to)
    for (const className of classes) result.push(parent(['controllers', root, className], `controller class ${className}${inModule(root)}`))
  }
  return result
}

function collide(a: Claim, b: Claim): boolean {
  const moves = (claim: Claim): boolean => claim.kind === 'rename' || claim.kind === 'drop'
  if (a.kind === 'parent') return moves(b)
  if (b.kind === 'parent') return moves(a)
  return true
}

function claimsOf(m: Modules, plan: OpenPlan): Map<string, Claim[]> {
  const byKey = new Map<string, Claim[]>()
  for (const target of m.listPlanAppTargets(plan.plan)) {
    for (const [key, claim] of claims(target)) byKey.set(key, [...(byKey.get(key) ?? []), claim])
  }
  return byKey
}

const idsOf = (claims: readonly Claim[]): string => [...new Set(claims.map((claim) => claim.id))].join(', ')

function overlaps(m: Modules, plans: readonly OpenPlan[]): CheckResult[] {
  const claimed = plans.map((plan) => claimsOf(m, plan))
  const results: CheckResult[] = []
  for (let i = 0; i < plans.length; i += 1) {
    for (let j = i + 1; j < plans.length; j += 1) {
      const shared: string[] = []
      for (const [key, mine] of claimed[i]) {
        const theirs = claimed[j].get(key) ?? []
        const a = mine.filter((claim) => theirs.some((other) => collide(claim, other)))
        if (a.length === 0) continue
        const b = theirs.filter((claim) => mine.some((other) => collide(other, claim)))
        const label = [...a, ...b].find((claim) => claim.kind !== 'parent')?.label ?? a[0].label
        shared.push(`${label} (${idsOf(a)} / ${idsOf(b)})`)
      }
      if (shared.length === 0) continue
      const [first, second] = [plans[i].file, plans[j].file]
      results.push({
        key: `plan:overlap:${first}:${second}`,
        title: 'Open plans overlap',
        status: 'warn',
        message: `${first} and ${second} are both approved and open, and both change: ${shared.sort().join('; ')}.`,
        suggestion: 'Land or close one plan before implementing the other, or revise one so they stop changing the same element.',
        filePath: first,
        advisory: true,
      })
    }
  }
  return results
}

export interface PlanCheckOptions {
  cwd: string
  routesFile?: string
}

export async function checkPlans(options: PlanCheckOptions): Promise<CheckResult[]> {
  const appRoot = options.cwd
  const discovery = await discoverPlanFiles(appRoot)
  const relative = (text: string): string => text.replaceAll(`${appRoot}${sep}`, '')
  const unreadable = (file: string, message: string, suggestion: string): CheckResult => ({
    key: `plan:unreadable:${file}`,
    title: 'Plan not read',
    status: 'warn',
    message: relative(message),
    suggestion,
    filePath: file,
    advisory: true,
  })
  const results = discovery.unreadable.map(({ dir, reason }) => {
    const file = toPosixRelative(appRoot, dir)
    return unreadable(file, `${file} could not be listed, so no plan in it was checked: ${reason}`, 'Fix the directory permissions.')
  })
  if (discovery.files.length === 0) return results

  const m = await loadModules()
  const slugs = new Map<string, string[]>()
  const open: OpenPlan[] = []
  for (const path of discovery.files) {
    const file = toPosixRelative(appRoot, path)
    const slug = m.planSlug(path)
    slugs.set(slug, [...(slugs.get(slug) ?? []), file])
    const classified = await classify(m, appRoot, path, file)
    if (classified.kind === 'open') open.push(classified.plan)
    else if (classified.kind === 'unreadable') results.push(unreadable(file, `${file} was not checked: ${classified.reason}`, 'Fix the file so guren plan:status can read it.'))
    else if (classified.kind === 'baseline-removed') {
      results.push({
        key: `plan:baseline-removed:${file}`,
        title: 'Approved plan lost its baseline',
        status: 'warn',
        message: relative(classified.reason),
        suggestion: `Restore the baseline, or run guren plan:approve ${file} to approve the draft again.`,
        filePath: file,
        advisory: true,
      })
    }
  }

  for (const [slug, files] of slugs) {
    if (files.length < 2) continue
    results.push({
      key: `plan:slug:${slug}`,
      title: 'Plans share a slug',
      status: 'warn',
      message: `${files.join(', ')} are all named "${slug}", so they share .guren/plans/${slug}.state.json and docs/plans/${slug}.md: one's verification records and close overwrite the other's.`,
      suggestion: 'Rename all but one plan file (or its directory).',
      filePath: files[0],
      advisory: true,
    })
  }

  if (open.length === 0) return results
  // An approval that predates the allowlist never ran it, and plan:next refuses such a plan.
  for (const plan of open) {
    for (const command of plan.plan.commands) {
      const verdict = m.judgePlanCommand(command.command)
      if (verdict.allowed) continue
      results.push({
        key: `plan:command:${plan.file}:${command.id}`,
        title: 'Approved plan carries a refused command',
        status: 'warn',
        message: `${plan.file}: ${command.id} (${JSON.stringify(command.command)}) is refused: ${verdict.reason}. plan:next hands out no step of this plan while it stays.`,
        suggestion: `Replace or remove the command, then run guren plan:approve ${plan.file} again.`,
        filePath: plan.file,
        advisory: true,
      })
    }
  }
  let app: Promise<PlanAppState> | undefined
  const loadApp = (): Promise<PlanAppState> => (app ??= m.loadPlanAppState(appRoot, { detail: true, routesFile: options.routesFile }))
  for (const plan of open) {
    let drifted: string[]
    try {
      const report = await m.planStatusFile(plan.path, { app: loadApp, appRoot, read: { path: plan.path, plan: plan.plan } })
      drifted = report.elements.filter((element) => element.state === 'drifted').map((element) => element.id)
    } catch (error) {
      results.push(unreadable(plan.file, `${plan.file} was not judged: ${(error as Error).message}`, `Run guren plan:status ${plan.file} to see the failure.`))
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
  results.push(...overlaps(m, open))
  return results
}
