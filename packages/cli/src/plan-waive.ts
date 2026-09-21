/**
 * `guren plan:waive` (RFC 0030 §6, §7): accept one element of an approved plan incomplete,
 * with a reason, in the decision log beside the plan. It runs nothing and loads no
 * application: a waiver is a person's decision, and the readers have already said what they
 * find. `plan:status`, `plan:verify` and the Stop hook report it through the one overlay.
 */

import { basename } from 'node:path'

import { CliError } from './cli-error'
import { readPlanFile } from './plan-render'
import { planDecisionsPath, planWaiverHash, removePlanWaiver, writePlanWaiver, type PlanWaiver } from './plan/decisions'
import { listPlanElements, type PlanDraft, type PlanElementSection } from './plan/schema'
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
