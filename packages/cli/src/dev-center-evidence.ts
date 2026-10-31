/**
 * The evidence beside each step of the Dev Center plan page (RFC 0032, "Plans in the Dev Center"):
 * the plan routes the step touches, its last `plan:verify` record, and the RFC 0033 browser steps
 * recorded for it. Plan files, `.guren/plans/` and `.guren/browser/` only; the application is never
 * imported, so a step's routes are the plan's own, which the page matches runtime errors against.
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { extname, join, resolve } from 'node:path'

import { isConfirmedApiOnlyApp } from './app-surface'
import { BROWSER_RUN_FILE, BROWSER_RUN_NAME, BROWSER_RUNS_DIR, BROWSER_SCREENSHOTS_DIR, browserRunSchema, type BrowserRun, type BrowserStep } from './browser-record'
import { locatePlan, NO_STORE, problem } from './dev-center-review'
import { readBesideRecord } from './plan/beside'
import type { PlanDraft, PlanRoute } from './plan/schema'
import { readPlanState, type PlanStepRecord, type PlanStepWork } from './plan/state'
import { derivePlanTasks, listPlanSteps, type PlanDerivedStep } from './plan/tasks'
import { sha256 } from './plan/verification'
import { resolveInside } from './plugin-manifest'

/** The newest runs read per request; run names start with their UTC stamp, so the name orders them. */
const MAX_RUNS = 50
const MAX_SCREENSHOT_BYTES = 20 * 1024 * 1024
const SCREENSHOT_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' }

export interface StepEvidenceRoute {
  id: string
  method: string
  path: string
  name: string
}

export interface StepBrowserEvidence {
  run: string
  feature: string
  origin: string
  commit: BrowserRun['commit']
  /** `acceptance`: the browser step's id is one of the plan step's acceptance ids. `feature`: the run names a feature the step renders. */
  match: 'acceptance' | 'feature'
  step: BrowserStep
}

export interface StepEvidence {
  id: string
  routes: StepEvidenceRoute[]
  /** Browser-map features (RFC 0033 §2) of the pages the step's views and routes render. */
  features: string[]
  record?: { outcome: PlanStepRecord['outcome']; ranAt: string; current: boolean; files: string[]; work?: PlanStepWork }
  browser: StepBrowserEvidence[]
}

export interface PlanEvidence {
  schemaVersion: 1
  file: string
  steps: StepEvidence[]
  runs: { read: number; skipped: number; unreadable: Array<{ run: string; reason: string }> }
  /** The state file would not read, so no step carries a record. */
  unreadable?: string
}

/** The feature RFC 0033 §2 groups a page under: its first path segment, behind its module. */
function featureOfView(view: { page: string; module?: string }): string {
  const segment = view.page.split('/')[0]!
  return view.module ? `${view.module}/${segment}` : segment
}

/** The plan routes and features a step's elements reach, read from the plan alone. */
export function stepTargets(plan: PlanDraft, step: Pick<PlanDerivedStep, 'elementIds' | 'acceptanceIds'>): { routes: PlanRoute[]; features: string[] } {
  const ids = new Set(step.elementIds)
  const actions = new Map(plan.controllers.flatMap((controller) => controller.actions.map((action) => [action.id, { action, controller: controller.id }] as const)))
  const views = new Map(plan.views.map((view) => [view.id, view]))
  const stepActions = new Set([...actions].filter(([id, { controller }]) => ids.has(id) || ids.has(controller)).map(([id]) => id))
  const stepViews = plan.views.filter((view) => ids.has(view.id))
  const viewRoutes = new Set(stepViews.flatMap((view) => [...(view.form ? [view.form.submitsTo] : []), ...view.actions.map((entry) => entry.route)]))
  const behaviourRoutes = new Set(plan.tasks.flatMap((task) => task.acceptance).filter((behaviour) => step.acceptanceIds.includes(behaviour.id)).map((behaviour) => behaviour.route))
  const rendered = (route: PlanRoute): string | undefined => {
    const response = actions.get(route.action)?.action.response
    return response?.kind === 'inertia' ? response.view : undefined
  }
  const stepViewIds = new Set(stepViews.map((view) => view.id))
  const routes = plan.routes.filter((route) => ids.has(route.id) || stepActions.has(route.action) || viewRoutes.has(route.id) || behaviourRoutes.has(route.id)
    || stepViewIds.has(rendered(route) ?? ''))
  const featureViews = [...stepViews, ...routes.flatMap((route) => { const view = views.get(rendered(route) ?? ''); return view ? [view] : [] })]
  return { routes, features: [...new Set(featureViews.map(featureOfView))].sort() }
}

async function readRuns(appRoot: string): Promise<{ runs: BrowserRun[]; skipped: number; unreadable: PlanEvidence['runs']['unreadable'] }> {
  const dir = join(resolve(appRoot), BROWSER_RUNS_DIR)
  let names: string[]
  try {
    names = (await readdir(dir, { withFileTypes: true })).filter((entry) => entry.isDirectory() && BROWSER_RUN_NAME.test(entry.name)).map((entry) => entry.name)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { runs: [], skipped: 0, unreadable: [] }
    return { runs: [], skipped: 0, unreadable: [{ run: BROWSER_RUNS_DIR, reason: `${BROWSER_RUNS_DIR} would not list: ${(error as Error).message}` }] }
  }
  names.sort().reverse()
  const runs: BrowserRun[] = []
  const unreadable: PlanEvidence['runs']['unreadable'] = []
  for (const name of names.slice(0, MAX_RUNS)) {
    const read = await readBesideRecord(join(dir, name, BROWSER_RUN_FILE), browserRunSchema, 'browser run')
    if (read.unreadable) unreadable.push({ run: name, reason: read.unreadable })
    else if (read.value && read.value.run !== name) unreadable.push({ run: name, reason: `run.json names run ${read.value.run}; it was copied from another run.` })
    else if (read.value) runs.push(read.value)
  }
  return { runs, skipped: Math.max(0, names.length - MAX_RUNS), unreadable }
}

export async function readPlanEvidence(appRoot: string, slug: string): Promise<PlanEvidence> {
  const located = await locatePlan(appRoot, slug)
  const apiOnly = await isConfirmedApiOnlyApp(appRoot).catch(() => false)
  const [stateRead, runs] = await Promise.all([readPlanState(appRoot, slug), readRuns(appRoot)])
  const records = stateRead.state?.steps ?? {}
  const steps = listPlanSteps(derivePlanTasks(located.plan, { apiOnly })).map(({ step }): StepEvidence => {
    const { routes, features } = stepTargets(located.plan, step)
    const record = records[step.id]
    const browser: StepBrowserEvidence[] = []
    for (const run of runs.runs) {
      for (const recorded of run.steps) {
        const match = step.acceptanceIds.includes(recorded.id) ? 'acceptance' : features.includes(run.feature) ? 'feature' : undefined
        if (match) browser.push({ run: run.run, feature: run.feature, origin: run.origin, commit: run.commit, match, step: recorded })
      }
    }
    return {
      id: step.id,
      routes: routes.map(({ id, method, path, name }) => ({ id, method, path, name })),
      features,
      ...(record ? { record: { outcome: record.outcome, ranAt: record.ranAt, current: record.planDigest === located.digest, files: Object.keys(record.fingerprint.files).sort(), ...(record.work ? { work: record.work } : {}) } } : {}),
      browser,
    }
  })
  return {
    schemaVersion: 1,
    file: located.file,
    steps,
    runs: { read: runs.runs.length, skipped: runs.skipped, unreadable: runs.unreadable },
    ...(stateRead.unreadable ? { unreadable: stateRead.unreadable } : {}),
  }
}

export async function handleEvidenceRequest(appRoot: string, slug: string): Promise<Response> {
  try {
    return Response.json(await readPlanEvidence(appRoot, slug), { headers: NO_STORE })
  } catch (error) {
    if (error instanceof Response) return error
    return problem(503, 'read-failed', 'The plan or its records could not be read.')
  }
}

/**
 * A screenshot `browser:record` digested. The run is one `.guren/browser/` lists, the file one its
 * `run.json` records under that digest, and the bytes are served only while they still hash to it.
 */
export async function serveBrowserScreenshot(appRoot: string, run: string, digest: string): Promise<Response> {
  const missing = problem(404, 'no-screenshot', 'No recorded screenshot has this name.')
  const dir = join(resolve(appRoot), BROWSER_RUNS_DIR)
  const name = (await readdir(dir).catch(() => [] as string[])).find((entry) => entry === run && BROWSER_RUN_NAME.test(entry))
  if (!name) return missing
  const read = await readBesideRecord(join(dir, name, BROWSER_RUN_FILE), browserRunSchema, 'browser run')
  const recorded = read.value?.run === name ? read.value.steps.flatMap((step) => step.cli.screenshots).find((shot) => shot.sha256 === digest) : undefined
  const prefix = `${BROWSER_SCREENSHOTS_DIR}/`
  const type = recorded ? SCREENSHOT_TYPES[extname(recorded.path).toLowerCase()] : undefined
  if (!recorded || !type || !recorded.path.startsWith(prefix)) return missing
  const target = await resolveInside(join(dir, name, BROWSER_SCREENSHOTS_DIR), recorded.path.slice(prefix.length))
  if (!target) return missing
  try {
    if ((await stat(target)).size > MAX_SCREENSHOT_BYTES) return problem(413, 'too-large', 'The screenshot is larger than the Dev Center serves.')
    const bytes = await readFile(target)
    if (sha256(bytes) !== digest) return problem(409, 'changed', 'The screenshot changed after browser:record digested it.')
    return new Response(bytes, { headers: { ...NO_STORE, 'Content-Type': type, 'Content-Security-Policy': "default-src 'none'; sandbox" } })
  } catch {
    return missing
  }
}
