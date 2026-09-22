/**
 * `guren plan:status` (RFC 0030 §6): what of a plan exists in the code, read the way
 * `check` and `doctor` read an application. It executes the routes file and imports
 * `db/schema.ts`, boots nothing and needs no database. The report is an observation,
 * so a plan with nothing implemented is as successful a run as a finished one.
 */

import { basename } from 'node:path'

import { readPlanFile } from './plan-render'
import type { PlanAppState } from './plan/app-state'
import { judgeFreshness, PLAN_FRESHNESS_VERDICTS, type PlanFreshness } from './plan/freshness'
import { planHash } from './plan/identity'
import { hasBaseline } from './plan/render'
import { judgePlan, PLAN_ELEMENT_STATES, PLAN_STATUS_SECTIONS, type PlanElementState, type PlanElementStatus, type PlanStatus } from './plan/status'
import { derivePlanTasks } from './plan/tasks'
import type { Plan, PlanDraft } from './plan/schema'
import { overlayVerification, type PlanVerificationSummary, type PlanWaiversRead } from './plan/verification'

/** Bumped when a field of {@link PlanStatusReport} changes meaning or goes away; additions do not bump it. */
export const PLAN_STATUS_REPORT_VERSION = 1

/** What `--json` prints. */
export interface PlanStatusReport extends PlanStatus<PlanElementState> {
  reportVersion: typeof PLAN_STATUS_REPORT_VERSION
  plan: { file: string; title: string; hash: string | null }
  /**
   * What `plan:verify` recorded under the application root, laid over the elements
   * (RFC 0030 §6). Absent when the command was given no application root to read it from.
   */
  verification?: PlanVerificationSummary
  /**
   * The application against `baseline.contextHash` (RFC 0030 §4). Absent for a draft,
   * which has no baseline to compare with.
   */
  freshness?: PlanFreshness
}

export interface PlanStatusFileOptions {
  /**
   * Loaded with `detail`, or nothing reads which app root an element sits in and every
   * element is `blocked`. Resolved after the plan parses.
   */
  app: PlanAppState | (() => Promise<PlanAppState>)
  cwd?: string
  /** Where `.guren/plans/` is read from. Without it, no verification is laid over the result. */
  appRoot?: string
  /** The plan the caller already read from `planPath`, so one run judges one reading of it. */
  read?: { path: string; plan: PlanDraft | Plan }
  /** The decision log the caller already read, for the same reason. */
  waivers?: PlanWaiversRead
}

export async function planStatusFile(planPath: string, options: PlanStatusFileOptions): Promise<PlanStatusReport> {
  const { path, plan } = options.read ?? (await readPlanFile(planPath, options.cwd))
  const app = typeof options.app === 'function' ? await options.app() : options.app
  const status = judgePlan(plan, app)
  const head = {
    reportVersion: PLAN_STATUS_REPORT_VERSION,
    plan: { file: basename(path), title: plan.title, hash: hasBaseline(plan) ? planHash(plan) : null },
  } satisfies Pick<PlanStatusReport, 'reportVersion' | 'plan'>
  const freshness = hasBaseline(plan) ? { freshness: judgeFreshness(plan, app) } : {}
  if (options.appRoot === undefined) return { ...head, ...status, ...freshness }
  const overlaid = await overlayVerification(options.appRoot, path, plan, status, derivePlanTasks(plan, { apiOnly: app.apiOnly }), { waivers: options.waivers })
  return { ...head, ...overlaid.status, verification: overlaid.verification, ...freshness }
}

const SECTION_TITLES: Record<(typeof PLAN_STATUS_SECTIONS)[number], string> = {
  models: 'Models',
  columns: 'Columns',
  validators: 'Validators',
  controllers: 'Controllers',
  actions: 'Actions',
  routes: 'Routes',
  views: 'Views',
  resources: 'Resources',
  policies: 'Policies',
  sideEffects: 'Side effects',
  commands: 'Commands',
}

function elementLines(element: PlanElementStatus<PlanElementState>, widths: { state: number; change: number; label: number }): string[] {
  const head = `  ${element.state.padEnd(widths.state)}  ${element.change.padEnd(widths.change)}  ${element.label.padEnd(widths.label)}  ${element.id}`
  const lines = [head.trimEnd()]
  if (element.reason) lines.push(`      ${element.reason}`)
  for (const property of element.properties) {
    if (property.verdict === 'differ') lines.push(`      differs: ${property.property} (planned ${property.planned}, found ${property.actual})`)
  }
  for (const note of element.notes) lines.push(`      ${note}`)
  return lines
}

export function formatPlanStatus(report: PlanStatusReport): string {
  const lines = [`${report.plan.title} (${report.plan.file})`, '']
  const widths = {
    state: Math.max(...PLAN_ELEMENT_STATES.map((state) => state.length)),
    change: 'existing'.length,
    label: Math.max(0, ...report.elements.map((element) => element.label.length)),
  }

  for (const section of PLAN_STATUS_SECTIONS) {
    const elements = report.elements.filter((element) => element.section === section)
    if (elements.length === 0) continue
    lines.push(SECTION_TITLES[section])
    for (const element of elements) lines.push(...elementLines(element, widths))
    lines.push('')
  }

  const { states, existing, properties, notCheckable } = report.summary
  const changed = PLAN_ELEMENT_STATES.reduce((total, state) => total + states[state], 0)
  lines.push(`Elements the plan changes: ${changed}`)
  lines.push(`  ${PLAN_ELEMENT_STATES.map((state) => `${state} ${states[state]}`).join(', ')}`)
  const named = (ids: string[]): string => (ids.length > 0 ? ` (${ids.join(', ')})` : '')
  lines.push(
    `Existing elements referenced: ${existing.found} found, ${existing.missing.length} missing${named(existing.missing)}, ${existing.unread.length} not readable${named(existing.unread)}`,
  )

  const compared = properties.match + properties.differ + properties.unknown
  lines.push(`Planned properties compared: ${compared} (match ${properties.match}, differ ${properties.differ}, not checkable ${properties.unknown})`)

  if (notCheckable.length > 0) {
    lines.push('', 'Planned, not checkable:')
    for (const entry of notCheckable) lines.push(`  ${entry.id}: ${entry.properties.join(', ')}`)
  }
  const verification = report.verification
  if (verification?.unreadable) lines.push('', `Verification records not read: ${verification.unreadable}`)
  if (verification && verification.staleSteps.length > 0) {
    lines.push('', `Verified against another plan or revision, so not counted: ${verification.staleSteps.join(', ')}`)
  }
  if (verification?.decisionsUnreadable) lines.push('', `Decision log not read: ${verification.decisionsUnreadable}`)
  if (verification && verification.staleWaivers.length > 0) {
    lines.push('', `Waived against another plan or revision, so not counted: ${verification.staleWaivers.map((waiver) => waiver.elementId).join(', ')}`)
  }
  if (verification && report.summary.states.waived > 0) lines.push('', `Waivers read from ${verification.decisionsFile}`)
  if (report.freshness) lines.push('', ...freshnessLines(report.freshness))
  return lines.join('\n')
}

function freshnessLines(freshness: PlanFreshness): string[] {
  const { summary, elements } = freshness
  const lines = [`Against the approved baseline: ${PLAN_FRESHNESS_VERDICTS.map((verdict) => `${verdict} ${summary[verdict]}`).join(', ')}`]
  for (const element of elements) {
    if (element.verdict !== 'stale') continue
    lines.push(`  stale  ${element.id}: ${element.reason}`)
    if (element.affects && element.affects.length > 0) lines.push(`         named by ${element.affects.join(', ')}`)
  }
  for (const verdict of ['unstamped', 'unjudged'] as const) {
    const ids = elements.filter((element) => element.verdict === verdict).map((element) => element.id)
    if (ids.length > 0) lines.push(`  ${verdict}: ${ids.join(', ')}`)
  }
  return lines
}
