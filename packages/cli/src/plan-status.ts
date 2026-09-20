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
import type { PlanElementSection } from './plan/schema'
import { judgePlan, PLAN_STATUS_SECTIONS, PLAN_STATUS_STATES, type PlanElementStatus, type PlanStatus } from './plan/status'

/** Bumped when a field of {@link PlanStatusReport} changes meaning or goes away; additions do not bump it. */
export const PLAN_STATUS_REPORT_VERSION = 1

/** What `--json` prints. */
export interface PlanStatusReport extends PlanStatus {
  reportVersion: typeof PLAN_STATUS_REPORT_VERSION
  plan: { file: string; title: string; hash: string | null }
}

export interface PlanStatusFileOptions {
  /** Loaded with `detail`, or every comparison past a name reads as not checkable. Resolved after the plan parses. */
  app: PlanAppState | (() => Promise<PlanAppState>)
  cwd?: string
}

export async function planStatusFile(planPath: string, options: PlanStatusFileOptions): Promise<PlanStatusReport> {
  const { path, plan } = await readPlanFile(planPath, options.cwd)
  const app = typeof options.app === 'function' ? await options.app() : options.app
  return {
    reportVersion: PLAN_STATUS_REPORT_VERSION,
    plan: { file: basename(path), title: plan.title, hash: hasBaseline(plan) ? planHash(plan) : null },
    ...judgePlan(plan, app),
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

function elementLines(element: PlanElementStatus, widths: { state: number; change: number; label: number }): string[] {
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
    state: Math.max(...PLAN_STATUS_STATES.map((state) => state.length)),
    change: 'existing'.length,
    label: Math.max(0, ...report.elements.map((element) => element.label.length)),
  }

  for (const section of PLAN_STATUS_SECTIONS) {
    const elements = report.elements.filter((element) => element.section === (section as PlanElementSection))
    if (elements.length === 0) continue
    lines.push(SECTION_TITLES[section])
    for (const element of elements) lines.push(...elementLines(element, widths))
    lines.push('')
  }

  const { states, existing, properties, notCheckable } = report.summary
  const changed = PLAN_STATUS_STATES.reduce((total, state) => total + states[state], 0)
  lines.push(`Elements the plan changes: ${changed}`)
  lines.push(`  ${PLAN_STATUS_STATES.map((state) => `${state} ${states[state]}`).join(', ')}`)
  lines.push(`Existing elements referenced: ${existing.found} found, ${existing.missing.length} missing${existing.missing.length > 0 ? ` (${existing.missing.join(', ')})` : ''}`)

  const compared = properties.match + properties.differ + properties.unknown
  lines.push(`Planned properties compared: ${compared} (match ${properties.match}, differ ${properties.differ}, not checkable ${properties.unknown})`)

  if (notCheckable.length > 0) {
    lines.push('', 'Planned, not checkable:')
    for (const entry of notCheckable) lines.push(`  ${entry.id}: ${entry.properties.join(', ')}`)
  }
  return lines.join('\n')
}
