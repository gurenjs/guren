/**
 * `guren plan:waive` (RFC 0030 §6, §7): accept one element of an approved plan incomplete,
 * with a reason, in the decision log beside the plan. It loads no application and runs
 * nothing but `git config`, which names who waived: a waiver is a person's decision, and
 * the readers have already said what they find. `plan:status`, `plan:verify` and the Stop
 * hook report it through the one overlay.
 */

import { basename, resolve } from 'node:path'

import { CliError } from './cli-error'
import { toPosixRelative } from './discovery'
import { readPlanFile } from './plan-render'
import { requirePlanApproval } from './plan/approvals'
import { gitAuthor } from './plan/beside'
import { planDecisionsPath, planWaiverHash, removePlanWaiver, writePlanWaiver, type PlanWaiver } from './plan/decisions'
import { hasBaseline } from './plan/render'
import { listPlanElements, type PlanChange, type PlanDraft, type PlanElementSection } from './plan/schema'
import { PLAN_STATUS_SECTIONS } from './plan/status'
import { runCaptured, type CapturedExec } from './subprocess'

export const PLAN_WAIVE_REPORT_VERSION = 1

/** What `--json` prints. */
export interface PlanWaiveReport {
  reportVersion: typeof PLAN_WAIVE_REPORT_VERSION
  /** `hash` is `null` only under `--remove`, which a draft's log may need as much as an approved one's. */
  plan: { file: string; title: string; hash: string | null }
  /** The decision log beside the plan, relative to the application root, POSIX separators. */
  decisionsFile: string
  waived: PlanWaiver[]
  /** Waivers of the same elements this run replaced, in the order they were given. */
  replaced: PlanWaiver[]
  /** With `--remove`: the waivers taken out; an element with none is not an error. */
  removed: PlanWaiver[]
  /** Whether the log changed. False where there was nothing to record, and no file was touched. */
  written: boolean
}

export interface PlanWaiveFileOptions {
  elementIds: readonly string[]
  /** Required unless `remove` is set: a waiver with no reason is not a decision. */
  reason?: string
  remove?: boolean
  /** What `decisionsFile` is reported relative to; the plan is not read from it. Defaults to `cwd`. */
  app?: string
  cwd?: string
  now?: () => Date
  /** How `git config` is asked who is waiving; absent authorship is not an error. */
  exec?: CapturedExec
}

/**
 * The `existing` elements, which are nobody's work and so have no state a waiver could lift.
 * Gathered here are the judged sections `plan/schema.ts` gives a `change`: a console command
 * declares none, and a flow declares one but is not judged. A judged section that gains a
 * `change` belongs here too, or its `existing` elements take a waiver that `applyWaivers()`
 * then declines to apply.
 */
function existingIds(plan: PlanDraft): Set<string> {
  const changed: ReadonlyArray<{ id: string; change: PlanChange }> = [
    ...plan.models,
    ...plan.models.flatMap((model) => model.columns),
    ...plan.controllers,
    ...plan.controllers.flatMap((controller) => controller.actions),
    ...plan.validators,
    ...plan.routes,
    ...plan.views,
    ...plan.resources,
    ...plan.policies,
    ...plan.sideEffects,
  ]
  return new Set(changed.filter((element) => element.change.kind === 'existing').map((element) => element.id))
}

const JUDGED = new Set<PlanElementSection>(PLAN_STATUS_SECTIONS)

/**
 * What to do instead, per section `plan:status` does not judge. A behaviour that fails makes its
 * `tests` command fail and the step is then `failed` whatever is waived, so waiving is not the
 * answer to one. A question covers no elements, so there is nothing to point at.
 */
const UNJUDGED_ADVICE: Partial<Record<PlanElementSection, string>> = {
  acceptance: 'A behaviour that fails leaves the step failed whatever is waived, so a behaviour the code will not satisfy is a revision, not a waiver.',
  flows: 'Waive the elements it covers instead.',
  tasks: 'Waive the elements it covers instead.',
}

export async function planWaiveFile(planPath: string, options: PlanWaiveFileOptions): Promise<PlanWaiveReport> {
  if (options.elementIds.length === 0) throw new CliError('Name at least one element id to waive.')
  const { path, plan } = await readPlanFile(planPath, options.cwd)
  const root = resolve(options.app ?? options.cwd ?? process.cwd())
  const head = (hash: string | null) =>
    ({
      reportVersion: PLAN_WAIVE_REPORT_VERSION,
      plan: { file: basename(path), title: plan.title, hash },
      decisionsFile: toPosixRelative(root, planDecisionsPath(path)),
    }) satisfies Pick<PlanWaiveReport, 'reportVersion' | 'plan' | 'decisionsFile'>

  // Removal matches on the element id and ignores the hash, so it asks none of the questions
  // below: withdrawing the waiver of an element a revision dropped is what it is for.
  if (options.remove) {
    const removed: PlanWaiver[] = []
    let written = false
    for (const id of options.elementIds) {
      const result = await removePlanWaiver(path, id)
      if (result.removed) removed.push(result.removed)
      written ||= result.written
    }
    return { ...head(planWaiverHash(plan) ?? null), waived: [], replaced: [], removed, written }
  }

  if (!hasBaseline(plan)) {
    throw new CliError(
      `${path} is a draft: it has no baseline, so it has no hash a waiver could name. A waiver is a decision about an approved plan; run guren plan:approve on it first.`,
    )
  }
  // The hash a waiver names is the plan's, so it must be one somebody approved.
  const { hash } = await requirePlanApproval(path, plan, 'no waiver is taken against it')

  const sections = new Map(listPlanElements(plan).map((element) => [element.id, element.section]))
  const existing = existingIds(plan)
  for (const id of options.elementIds) {
    const section = sections.get(id)
    if (section === undefined) {
      throw new CliError(`No element "${id}" is declared by this plan. The elements are:\n${[...sections.keys()].map((known) => `  ${known}`).join('\n')}`)
    }
    if (!JUDGED.has(section)) {
      const refusal = `"${id}" is a ${section} element, which plan:status does not judge, so it has no state a waiver could lift.`
      throw new CliError([refusal, UNJUDGED_ADVICE[section]].filter(Boolean).join(' '))
    }
    if (existing.has(id)) {
      throw new CliError(`"${id}" is an existing element, which the plan changes nothing about, so it is no part of completion and there is nothing to waive.`)
    }
  }

  const reason = options.reason?.trim()
  if (!reason) throw new CliError('A waiver records why an element was accepted incomplete, so --reason is required.')

  const at = (options.now ?? (() => new Date()))().toISOString()
  const by = await gitAuthor(root, options.exec ?? runCaptured)
  const waived: PlanWaiver[] = []
  const replaced: PlanWaiver[] = []
  let written = false
  for (const id of options.elementIds) {
    const waiver: PlanWaiver = { elementId: id, planHash: hash, reason, at, ...(by ? { by } : {}) }
    const result = await writePlanWaiver(path, waiver)
    waived.push(waiver)
    written ||= result.written
    if (result.replaced) replaced.push(result.replaced)
  }
  return { ...head(hash), waived, replaced, removed: [], written }
}

export function formatPlanWaive(report: PlanWaiveReport): string {
  const lines = [`${report.plan.title} (${report.plan.file})`, '']
  for (const waiver of report.removed) lines.push(`Removed the waiver of ${waiver.elementId} (${waiver.reason})`)
  if (report.removed.length === 0 && report.waived.length === 0) lines.push('Nothing was waived here, so nothing was removed.')
  for (const waiver of report.waived) {
    const replaced = report.replaced.find((earlier) => earlier.elementId === waiver.elementId)
    lines.push(`Waived ${waiver.elementId}: ${waiver.reason}`)
    if (replaced) lines.push(`  replaces the waiver of ${replaced.at}: ${replaced.reason}`)
  }
  lines.push(
    '',
    report.written ? `Recorded in ${report.decisionsFile}` : `Nothing to record; ${report.decisionsFile} was left alone.`,
    'The decision log is committed with the plan. A waiver names this plan hash, so a revision does not inherit it.',
  )
  return lines.join('\n')
}
