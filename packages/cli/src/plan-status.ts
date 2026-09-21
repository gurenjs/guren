/**
 * `guren plan:status` (RFC 0030 §6): what of a plan exists in the code, read the way
 * `check` and `doctor` read an application. It executes the routes file and imports
 * `db/schema.ts`, boots nothing and needs no database. The report is an observation,
 * so a plan with nothing implemented is as successful a run as a finished one.
 */

import { basename } from 'node:path'

import { readPlanFile } from './plan-render'
import type { PlanAppState } from './plan/app-state'
import { planHash } from './plan/identity'
import { hasBaseline } from './plan/render'
import { judgePlan, PLAN_ELEMENT_STATES, PLAN_STATUS_SECTIONS, type PlanElementState, type PlanElementStatus, type PlanStatus } from './plan/status'
import { derivePlanTasks } from './plan/tasks'
import { overlayVerification, type PlanVerificationSummary } from './plan/verification'

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
}

export async function planStatusFile(planPath: string, options: PlanStatusFileOptions): Promise<PlanStatusReport> {
  const { path, plan } = await readPlanFile(planPath, options.cwd)
  const app = typeof options.app === 'function' ? await options.app() : options.app
  const status = judgePlan(plan, app)
  const overlaid = options.appRoot === undefined ? undefined : await overlayVerification(options.appRoot, path, plan, status, derivePlanTasks(plan, { apiOnly: app.apiOnly }))
  return {
    reportVersion: PLAN_STATUS_REPORT_VERSION,
    plan: { file: basename(path), title: plan.title, hash: hasBaseline(plan) ? planHash(plan) : null },
    ...(overlaid?.status ?? status),
    ...(overlaid ? { verification: overlaid.verification } : {}),
  }
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
  return lines.join('\n')
}
