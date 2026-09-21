/**
 * `guren plan:waive` (RFC 0030 §6, §7): accept one element of an approved plan incomplete,
 * with a reason, in the decision log beside the plan. It loads no application and runs
 * nothing but `git config`, which names who waived: a waiver is a person's decision, and
 * the readers have already said what they find. `plan:status`, `plan:verify` and the Stop
 * hook report it through the one overlay.
 */

import { basename } from 'node:path'

import { CliError } from './cli-error'
import { readPlanFile } from './plan-render'
import { planDecisionsPath, planWaiverHash, removePlanWaiver, writePlanWaiver, type PlanWaiver } from './plan/decisions'
import { listPlanElements, type PlanChange, type PlanDraft, type PlanElementSection } from './plan/schema'
import { PLAN_STATUS_SECTIONS } from './plan/status'
import { runCaptured, type CapturedExec } from './subprocess'

export const PLAN_WAIVE_REPORT_VERSION = 1

/** What `--json` prints. */
export interface PlanWaiveReport {
  reportVersion: typeof PLAN_WAIVE_REPORT_VERSION
  plan: { file: string; title: string; hash: string }
  /** Absolute path of the decision log beside the plan. */
  decisionsFile: string
  waived: PlanWaiver[]
  /** Waivers of the same elements this run replaced, in the order they were given. */
  replaced: PlanWaiver[]
  /** With `--remove`: the waivers taken out; an element with none is not an error. */
  removed: PlanWaiver[]
}

export interface PlanWaiveFileOptions {
  elementIds: readonly string[]
  /** Required unless `remove` is set: a waiver with no reason is not a decision. */
  reason?: string
  remove?: boolean
  cwd?: string
  now?: () => Date
  /** How `git config` is asked who is waiving; absent authorship is not an error. */
  exec?: CapturedExec
}

/** `git config` on a machine with no identity answers nothing, which the waiver simply omits. */
async function waiverAuthor(cwd: string, exec: CapturedExec): Promise<string | undefined> {
  const value = async (key: string): Promise<string | undefined> => {
    try {
      const run = await exec(['git', 'config', '--get', key], cwd)
      const text = run.stdout.trim()
      return run.exitCode === 0 && text.length > 0 ? text : undefined
    } catch {
      return undefined
    }
  }
  const name = await value('user.name')
  const email = await value('user.email')
  if (name && email) return `${name} <${email}>`
  return name ?? email
}

function sectionOf(plan: PlanDraft): Map<string, PlanElementSection> {
  return new Map(listPlanElements(plan).map((element) => [element.id, element.section]))
}

/**
 * The `existing` elements, which are nobody's work and so have no state a waiver could lift.
 * The sections listed here are the ones `plan/schema.ts` gives a `change`; a console command
 * declares none and is never one. A section that gains one belongs here too, or its `existing`
 * elements take a waiver that `applyWaivers()` then declines to apply.
 */
function existingIds(plan: PlanDraft): Set<string> {
  const ids = new Set<string>()
  const add = (items: ReadonlyArray<{ id: string; change: PlanChange }>): void => {
    for (const item of items) if (item.change.kind === 'existing') ids.add(item.id)
  }
  for (const model of plan.models) {
    add([model])
    add(model.columns)
  }
  for (const controller of plan.controllers) {
    add([controller])
    add(controller.actions)
  }
  add(plan.validators)
  add(plan.routes)
  add(plan.views)
  add(plan.resources)
  add(plan.policies)
  add(plan.sideEffects)
  return ids
}

const JUDGED = new Set<PlanElementSection>(PLAN_STATUS_SECTIONS)

export async function planWaiveFile(planPath: string, options: PlanWaiveFileOptions): Promise<PlanWaiveReport> {
  const { path, plan } = await readPlanFile(planPath, options.cwd)
  if (options.elementIds.length === 0) throw new CliError('Name at least one element id to waive.')

  const hash = planWaiverHash(plan)
  if (hash === undefined) {
    throw new CliError(
      `${path} is a draft: it has no baseline, so it has no hash a waiver could name. A waiver is a decision about an approved plan; approve this one first.`,
    )
  }

  const sections = sectionOf(plan)
  const existing = existingIds(plan)
  for (const id of options.elementIds) {
    const section = sections.get(id)
    if (section === undefined) {
      throw new CliError(`No element "${id}" is declared by this plan. The elements are:\n${[...sections.keys()].map((known) => `  ${known}`).join('\n')}`)
    }
    if (!JUDGED.has(section)) {
      throw new CliError(
        `"${id}" is a ${section} element, which plan:status does not judge, so it has no state a waiver could lift. Waive the elements it covers instead.`,
      )
    }
    if (existing.has(id)) {
      throw new CliError(`"${id}" is an existing element, which the plan changes nothing about, so it is no part of completion and there is nothing to waive.`)
    }
  }

  const head = {
    reportVersion: PLAN_WAIVE_REPORT_VERSION,
    plan: { file: basename(path), title: plan.title, hash },
    decisionsFile: planDecisionsPath(path),
  } satisfies Pick<PlanWaiveReport, 'reportVersion' | 'plan' | 'decisionsFile'>

  if (options.remove) {
    const removed: PlanWaiver[] = []
    for (const id of options.elementIds) {
      const result = await removePlanWaiver(path, id)
      if (result.removed) removed.push(result.removed)
    }
    return { ...head, waived: [], replaced: [], removed }
  }

  const reason = options.reason?.trim()
  if (!reason) throw new CliError('A waiver records why an element was accepted incomplete, so --reason is required.')

  const at = (options.now ?? (() => new Date()))().toISOString()
  const by = await waiverAuthor(options.cwd ?? process.cwd(), options.exec ?? runCaptured)
  const waived: PlanWaiver[] = []
  const replaced: PlanWaiver[] = []
  for (const id of options.elementIds) {
    const waiver: PlanWaiver = { elementId: id, planHash: hash, reason, at, ...(by ? { by } : {}) }
    const result = await writePlanWaiver(path, waiver)
    waived.push(waiver)
    if (result.replaced) replaced.push(result.replaced)
  }
  return { ...head, waived, replaced, removed: [] }
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
    `Recorded in ${report.decisionsFile}`,
    'The decision log is committed with the plan. A waiver names this plan hash, so a revision does not inherit it.',
  )
  return lines.join('\n')
}
