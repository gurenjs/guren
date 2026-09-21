/**
 * `guren plan:next` (RFC 0030 §7): the next step of a plan to implement, with what that step
 * needs and nothing of the rest, and the mark the Stop hook reads to know which step a
 * session is on. It runs nothing and never loads the application: the records under
 * `.guren/plans/` say what is verified, the plan says what the step covers. A dirty tree
 * is refused unless it is the marked step's own work: one step is one commit.
 */

import { basename } from 'node:path'

import { isConfirmedApiOnlyApp } from './app-surface'
import { runGit } from './changed-files'
import { CliError } from './cli-error'
import { toPosixRelative } from './discovery'
import { readPlanFile } from './plan-render'
import { planHash } from './plan/identity'
import { hasBaseline } from './plan/render'
import { listPlanElements, type PlanAcceptance, type PlanDraft, type PlanElementSection } from './plan/schema'
import { planDigest, planSlug, planStatePath, readPlanState, writePlanActiveStep, type PlanActiveStep, type PlanStall } from './plan/state'
import { derivePlanTasks, listPlanSteps, type PlanDerivedStep, type PlanDerivedTask, type PlanTaskTitle } from './plan/tasks'
import { hashFiles, recordStillHolds } from './plan/verification'

export const PLAN_NEXT_REPORT_VERSION = 1

export interface PlanNextElement {
  id: string
  section: PlanElementSection
  /** The plan's element, verbatim. */
  element: unknown
}

export interface PlanNextStep extends Pick<PlanDerivedStep, 'id' | 'kind' | 'verify' | 'generates' | 'part'> {
  taskId: string
  task: PlanTaskTitle
  /** The elements the step completes. */
  elements: PlanNextElement[]
  /** The behaviours the step writes or must see pass. */
  acceptance: PlanAcceptance[]
  /** Where the Stop hook gave up on this step; cleared by this call, so the next run of the loop is asked again. */
  stalled?: PlanStall
}

/** What `--json` prints. */
export interface PlanNextReport {
  reportVersion: typeof PLAN_NEXT_REPORT_VERSION
  plan: { file: string; title: string; hash: string | null }
  /** Steps whose record still holds, in task order. */
  verified: string[]
  /** `null` when every step is verified. */
  step: PlanNextStep | null
  /** Relative to the application root, POSIX separators. */
  stateFile: string
}

export interface PlanNextFileOptions {
  appRoot: string
  cwd?: string
  now?: () => Date
}

/** The items a section holds; three sections are nested inside another's items. */
function sectionItems(plan: PlanDraft, section: PlanElementSection): ReadonlyArray<{ id: string }> {
  switch (section) {
    case 'columns':
      return plan.models.flatMap((model) => model.columns)
    case 'actions':
      return plan.controllers.flatMap((controller) => controller.actions)
    case 'acceptance':
      return plan.tasks.flatMap((task) => task.acceptance)
    default:
      return plan[section]
  }
}

function elementsOf(plan: PlanDraft, ids: readonly string[]): PlanNextElement[] {
  const wanted = new Set(ids)
  const found: PlanNextElement[] = []
  for (const { id, section } of listPlanElements(plan)) {
    if (wanted.has(id)) found.push({ id, section, element: sectionItems(plan, section).find((item) => item.id === id) })
  }
  return found
}

export async function planNextFile(planPath: string, options: PlanNextFileOptions): Promise<PlanNextReport> {
  const { path, plan } = await readPlanFile(planPath, options.cwd)
  const root = options.appRoot
  const derivation = derivePlanTasks(plan, { apiOnly: await isConfirmedApiOnlyApp(root).catch(() => false) })
  const digest = planDigest(plan)
  const slug = planSlug(path)
  const state = (await readPlanState(root, slug)).state
  const records = state?.steps ?? {}
  const hashes = await hashFiles(root, Object.values(records).flatMap((record) => Object.keys(record.fingerprint.files)))

  const verified: string[] = []
  let next: { task: PlanDerivedTask; step: PlanDerivedStep } | undefined
  for (const entry of listPlanSteps(derivation)) {
    const record = records[entry.step.id]
    if (record && recordStillHolds(record, digest, hashes, entry.step)) verified.push(entry.step.id)
    else next ??= entry
  }

  const head = {
    reportVersion: PLAN_NEXT_REPORT_VERSION,
    plan: { file: basename(path), title: plan.title, hash: hasBaseline(plan) ? planHash(plan) : null },
    verified,
    stateFile: toPosixRelative(root, planStatePath(root, slug)),
  } satisfies Omit<PlanNextReport, 'step'>
  const previous = state?.active
  if (next === undefined) {
    if (previous) await writePlanActiveStep(root, slug, undefined)
    return { ...head, step: null }
  }
  const { task, step } = next

  // The state is git-ignored, so the mark this call writes never makes the tree dirty.
  const dirty = (await runGit(root, ['status', '--porcelain', '--', '.'])) ?? []
  if (dirty.length > 0 && previous?.step !== step.id) {
    throw new CliError(
      `The working tree under ${root} has uncommitted changes, and one step is one commit. Commit or discard them first:\n${dirty
        .slice(0, 10)
        .map((line) => `  ${line}`)
        .join('\n')}${dirty.length > 10 ? `\n  … and ${dirty.length - 10} more` : ''}`,
    )
  }

  const behaviours = new Set(step.acceptanceIds)
  // A stall is what the last session ended on: reported once, then the hook is asked again.
  const resumed = previous && previous.step === step.id && !previous.stalled ? previous : undefined
  const active: PlanActiveStep = resumed ?? {
    plan: toPosixRelative(root, path),
    step: step.id,
    startedAt: (options.now ?? (() => new Date()))().toISOString(),
    continuations: 0,
  }
  await writePlanActiveStep(root, slug, active)

  return {
    ...head,
    step: {
      id: step.id,
      kind: step.kind,
      verify: step.verify,
      generates: step.generates,
      ...(step.part ? { part: step.part } : {}),
      taskId: task.id,
      task: task.title,
      elements: elementsOf(plan, step.elementIds),
      acceptance: plan.tasks.flatMap((intent) => intent.acceptance).filter((behaviour) => behaviours.has(behaviour.id)),
      ...(previous?.step === step.id && previous.stalled ? { stalled: previous.stalled } : {}),
    },
  }
}

function describeTask(title: PlanTaskTitle): string {
  switch (title.kind) {
    case 'foundation':
      return 'foundation'
    case 'entity':
      return `entity ${title.name}`
    case 'story':
      return `story ${title.name}`
    case 'cross':
      return `cross-entity ${title.models.join(', ')}`
  }
}

function describeExpectation(behaviour: PlanAcceptance): string {
  const parts: string[] = []
  if (behaviour.expect.status !== undefined) parts.push(`status ${behaviour.expect.status}`)
  if (behaviour.expect.redirect !== undefined) parts.push(`redirect ${behaviour.expect.redirect}`)
  if (behaviour.expect.inertia !== undefined) parts.push(`renders ${behaviour.expect.inertia}`)
  if (behaviour.expect.errors?.length) parts.push(`errors on ${behaviour.expect.errors.join(', ')}`)
  for (const row of behaviour.expect.database ?? []) {
    if (row.has?.length) parts.push(`${row.table} has ${row.has.length} row(s)`)
    if (row.missing?.length) parts.push(`${row.table} lacks ${row.missing.length} row(s)`)
  }
  return parts.join('; ')
}

export function formatPlanNext(report: PlanNextReport, planArgument: string): string {
  const lines = [`${report.plan.title} (${report.plan.file})`, '']
  if (report.verified.length > 0) lines.push(`Verified: ${report.verified.join(', ')}`, '')
  const step = report.step
  if (step === null) {
    lines.push('Every step is verified. Nothing is left to implement.')
    return lines.join('\n')
  }
  const part = step.part ? ` (part ${step.part.index} of ${step.part.of})` : ''
  lines.push(`Next: ${step.id}${part}`, `  task: ${describeTask(step.task)} (${step.taskId})`, `  verify: ${step.verify.join(' → ')}`)
  if (step.elements.length > 0) {
    lines.push('', 'Elements the step completes:')
    for (const element of step.elements) lines.push(`  ${element.id} (${element.section})`)
  }
  if (step.generates.length > 0) lines.push('', `Generates a first version of: ${step.generates.join(', ')}`)
  if (step.acceptance.length > 0) {
    lines.push('', `Behaviours${step.kind === 'tests' ? ' to write, as test titles `[<id>] <description>`, failing' : ' that must pass'}:`)
    for (const behaviour of step.acceptance) {
      lines.push(`  [${behaviour.id}] ${behaviour.description}`)
      lines.push(`      ${behaviour.kind}; actor ${behaviour.actor}; route ${behaviour.route}${behaviour.given.length ? `; given ${behaviour.given.join(', ')}` : ''}; expect ${describeExpectation(behaviour)}`)
    }
  }
  if (step.stalled) {
    lines.push('', `Stalled ${step.stalled.at}: ${step.stalled.reason}`, ...step.stalled.output.split('\n').map((line) => `  ${line}`))
  }
  lines.push('', `Implement this step only, then run \`bunx guren plan:verify ${planArgument} --step ${step.id}\` and commit once it is verified.`, `Marked in ${report.stateFile}`)
  return lines.join('\n')
}
