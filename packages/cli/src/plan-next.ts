/**
 * `guren plan:next` (RFC 0030 §7): the next step of a plan to implement, with what that step
 * needs and nothing of the rest, and the mark the Stop hook reads to know which step a
 * session is on. It spawns no command: the records under `.guren/plans/` say what is
 * verified, the plan says what the step covers. A plan with a baseline also has the app read
 * (the routes file is imported), so a step on stale context (§4) is skipped and named.
 * A dirty tree is refused unless it is the marked step's own work: one step is one commit.
 */

import { basename } from 'node:path'

import { isConfirmedApiOnlyApp } from './app-surface'
import type { CheckStatus } from './check-result'
import { runGit } from './changed-files'
import { CliError } from './cli-error'
import { toPosixRelative } from './discovery'
import { readPlanFile } from './plan-render'
import { loadPlanAppState, type PlanAppState } from './plan/app-state'
import { planDecisionsPath, type PlanWaiver } from './plan/decisions'
import { judgeFreshness } from './plan/freshness'
import { planHash } from './plan/identity'
import { hasBaseline } from './plan/render'
import { listPlanElements, type PlanAcceptance, type PlanDraft, type PlanElementSection } from './plan/schema'
import { judgeStepContext, type PlanStepContext, type PlanStepContextElement } from './plan/stale-steps'
import { ensurePlanStateIgnored, PLAN_STATE_DIR, planDigest, planSlug, planStatePath, readPlanState, writePlanActiveStep, type PlanActiveStep, type PlanStall } from './plan/state'
import { derivePlanTasks, listPlanSteps, type PlanDerivedStep, type PlanDerivedTask, type PlanTaskDerivation, type PlanTaskTitle } from './plan/tasks'
import { validatePlan } from './plan/validate'
import { hashFiles, readPlanWaivers, recordStillHolds } from './plan/verification'

export const PLAN_NEXT_REPORT_VERSION = 1

export interface PlanNextElement {
  id: string
  section: PlanElementSection
  /** The plan's element, verbatim. */
  element: unknown
  /** Set where the decision log waives this element at the plan's hash: it is nobody's work. */
  waived?: { reason: string; at: string; by?: string }
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
  /** What the step depends on whose freshness could not be judged (§4); it blocks nothing. */
  unjudged?: PlanStepContextElement[]
}

export interface PlanNextStaleElement extends PlanStepContextElement {
  /** The §2 checks re-run for the element against the application as it reads now; passes left out. */
  checks: Array<{ key: string; status: CheckStatus; message: string }>
}

/** A step skipped because what it depends on changed since approval (RFC 0030 §4). */
export interface PlanNextBlockedStep {
  id: string
  taskId: string
  stale: PlanNextStaleElement[]
  /** The Stop hook's stall on this step, reported here since the step is not returned. */
  stalled?: PlanStall
}

/** What `--json` prints. */
export interface PlanNextReport {
  reportVersion: typeof PLAN_NEXT_REPORT_VERSION
  plan: { file: string; title: string; hash: string | null }
  /** Steps whose record still holds, in task order. */
  verified: string[]
  /** The verified steps whose record fingerprinted nothing: done on their commands, their elements never lifted by `plan:status`. */
  onCommandsAlone: string[]
  /** `null` when every step is verified, or every one left is blocked or waits on one that is. */
  step: PlanNextStep | null
  /** In task order; always empty for a draft, which has no baseline to be stale against. */
  blocked: PlanNextBlockedStep[]
  /** Steps held behind a blocked one they come after in their task or whose task they wait for. */
  waiting: Array<{ id: string; on: string[] }>
  /** Relative to the application root, POSIX separators. */
  stateFile: string
  /** The decision log beside the plan, relative to the application root; it need not exist. */
  decisionsFile: string
  /** Set when a decision log exists and would not read, so no waiver was applied to this report. */
  decisionsUnreadable?: string
  /** Set when the application could not be read for a plan with a baseline, so no step was judged stale. */
  freshnessUnreadable?: string
}

export interface PlanNextFileOptions {
  appRoot: string
  /** Read only for a plan with a baseline. Defaults to {@link loadPlanAppState} without `detail`. */
  app?: PlanAppState | (() => Promise<PlanAppState>)
  cwd?: string
  now?: () => Date
}

/** The items a section holds; some sections are nested inside another's items. */
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

function elementsOf(plan: PlanDraft, ids: readonly string[], waivers: ReadonlyMap<string, PlanWaiver>): PlanNextElement[] {
  const wanted = new Set(ids)
  const found: PlanNextElement[] = []
  for (const { id, section } of listPlanElements(plan)) {
    if (!wanted.has(id)) continue
    const waiver = waivers.get(id)
    found.push({
      id,
      section,
      element: sectionItems(plan, section).find((item) => item.id === id),
      ...(waiver ? { waived: { reason: waiver.reason, at: waiver.at, ...(waiver.by ? { by: waiver.by } : {}) } } : {}),
    })
  }
  return found
}

/**
 * The steps of a plan with a baseline that depend on a non-fresh element, keyed by step id.
 * A load that throws judges nothing stale: it is not evidence that anything changed.
 */
async function stepContexts(
  plan: PlanDraft,
  derivation: PlanTaskDerivation,
  options: PlanNextFileOptions,
  inProgress: string | undefined,
): Promise<{ contexts: Map<string, PlanStepContext>; app?: PlanAppState; unreadable?: string }> {
  if (!hasBaseline(plan)) return { contexts: new Map() }
  let app: PlanAppState
  try {
    const source = options.app ?? (() => loadPlanAppState(options.appRoot))
    app = typeof source === 'function' ? await source() : source
  } catch (error) {
    return { contexts: new Map(), unreadable: error instanceof Error ? error.message : String(error) }
  }
  const contexts = judgeStepContext(judgeFreshness(plan, app), derivation, { inProgress })
  return { contexts: new Map(contexts.map((context) => [context.stepId, context])), app }
}

export async function planNextFile(planPath: string, options: PlanNextFileOptions): Promise<PlanNextReport> {
  const { path, plan } = await readPlanFile(planPath, options.cwd)
  const root = options.appRoot
  const derivation = derivePlanTasks(plan, { apiOnly: await isConfirmedApiOnlyApp(root).catch(() => false) })
  const digest = planDigest(plan)
  const slug = planSlug(path)
  const state = (await readPlanState(root, slug)).state
  const records = state?.steps ?? {}
  const previous = state?.active
  const hashes = await hashFiles(root, Object.values(records).flatMap((record) => Object.keys(record.fingerprint.files)))
  const log = await readPlanWaivers(path, plan)
  const inProgress = previous && !previous.stalled ? previous.step : undefined
  const judged = await stepContexts(plan, derivation, options, inProgress)
  const checks = judged.app ? validatePlan(plan, judged.app) : []

  const verified: string[] = []
  const onCommandsAlone: string[] = []
  const blocked: PlanNextBlockedStep[] = []
  const waiting: PlanNextReport['waiting'] = []
  // A blocked step holds the rest of its task and every task waiting for it: a step depends on the ones before it.
  const heldBy = new Map<string, Set<string>>()
  let next: { task: PlanDerivedTask; step: PlanDerivedStep } | undefined
  for (const entry of listPlanSteps(derivation)) {
    const { task, step } = entry
    let held = heldBy.get(task.id)
    if (!held) {
      held = new Set(task.dependsOn.flatMap((id) => [...(heldBy.get(id) ?? [])]))
      heldBy.set(task.id, held)
    }
    const record = records[step.id]
    if (record && recordStillHolds(record, digest, hashes, log.waived)) {
      verified.push(step.id)
      if (Object.keys(record.fingerprint.files).length === 0) onCommandsAlone.push(step.id)
      continue
    }
    const stale = judged.contexts.get(step.id)?.stale ?? []
    if (stale.length > 0) {
      blocked.push({
        id: step.id,
        taskId: task.id,
        stale: stale.map((element) => ({
          ...element,
          checks: checks.filter((result) => result.elementId === element.id && result.status !== 'pass').map(({ key, status, message }) => ({ key, status, message })),
        })),
        ...(previous?.step === step.id && previous.stalled ? { stalled: previous.stalled } : {}),
      })
      held.add(step.id)
    } else if (held.size > 0) {
      waiting.push({ id: step.id, on: [...held] })
    } else {
      next ??= entry
    }
  }

  const head = {
    reportVersion: PLAN_NEXT_REPORT_VERSION,
    plan: { file: basename(path), title: plan.title, hash: hasBaseline(plan) ? planHash(plan) : null },
    verified,
    onCommandsAlone,
    blocked,
    waiting,
    stateFile: toPosixRelative(root, planStatePath(root, slug)),
    decisionsFile: toPosixRelative(root, planDecisionsPath(path)),
    ...(log.unreadable ? { decisionsUnreadable: log.unreadable } : {}),
    ...(judged.unreadable ? { freshnessUnreadable: judged.unreadable } : {}),
  } satisfies Omit<PlanNextReport, 'step'>
  if (next === undefined) {
    if (previous) await writePlanActiveStep(root, slug, undefined)
    return { ...head, step: null }
  }
  const { task, step } = next

  // The state files are git-ignored before the tree is read, and excluded from the reading for a
  // checkout that tracked them before, so neither an earlier run's write nor the mark makes it
  // dirty. Excluded by pathspec, since porcelain paths are relative to the repository root, not to `root`.
  await ensurePlanStateIgnored(root)
  const dirty = (await runGit(root, ['status', '--porcelain', '--', '.', `:(exclude,glob)${PLAN_STATE_DIR}/*.state.json`, `:(exclude)${PLAN_STATE_DIR}/.gitignore`])) ?? []
  if (dirty.length > 0 && previous?.step !== step.id) {
    const markedBlocked = blocked.some((entry) => entry.id === previous?.step)
    throw new CliError(
      `The working tree under ${root} has uncommitted changes (paths relative to the repository root), and one step is one commit. Commit or discard them first:\n${dirty
        .slice(0, 10)
        .map((line) => `  ${line}`)
        .join('\n')}${dirty.length > 10 ? `\n  … and ${dirty.length - 10} more` : ''}${
        markedBlocked ? `\nThe marked step ${previous!.step} is blocked: what it depends on changed since the plan was approved (plan:status names it).` : ''
      }`,
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
  const unjudged = judged.contexts.get(step.id)?.unjudged ?? []

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
      elements: elementsOf(plan, step.elementIds, log.waivers),
      acceptance: plan.tasks.flatMap((intent) => intent.acceptance).filter((behaviour) => behaviours.has(behaviour.id)),
      ...(previous?.step === step.id && previous.stalled ? { stalled: previous.stalled } : {}),
      ...(unjudged.length > 0 ? { unjudged } : {}),
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

function blockedLines(report: PlanNextReport, planArgument: string): string[] {
  if (report.blocked.length === 0) return []
  const lines = ['', 'Blocked, since what they depend on changed after the plan was approved:']
  for (const blocked of report.blocked) {
    lines.push(`  ${blocked.id}`)
    for (const element of blocked.stale) {
      lines.push(`    ${element.id} (${element.section}, ${element.change}), ${element.owned ? 'owned by the step' : `named by ${element.through.join(', ')}`}: ${element.reason ?? 'stale'}`)
      if (element.checks.length === 0) lines.push('      the reference checks pass for it against the application as it reads now')
      for (const check of element.checks) lines.push(`      ${check.status}  ${check.message}`)
    }
    if (blocked.stalled) lines.push(`    stalled ${blocked.stalled.at}: ${blocked.stalled.reason}`)
  }
  if (report.waiting.length > 0) {
    lines.push('', 'Waiting on a blocked step:', ...report.waiting.map((entry) => `  ${entry.id} (on ${entry.on.join(', ')})`))
  }
  lines.push(
    '',
    'A blocked step is a person\u2019s decision: revise the plan so it states what the application holds now (edit it, or run a revision)',
    `  and approve the result with \`bunx guren plan:approve ${planArgument}\`, or undo the change that moved it.`,
  )
  return lines
}

export function formatPlanNext(report: PlanNextReport, planArgument: string): string {
  const lines = [`${report.plan.title} (${report.plan.file})`, '']
  if (report.verified.length > 0) lines.push(`Verified: ${report.verified.join(', ')}`, '')
  const step = report.step
  if (step === null && report.blocked.length > 0) {
    lines.push('No step can be returned: every step left is blocked, or waits on one that is. A person decides how the plan meets the application now.')
  } else if (step === null) {
    lines.push('Every step is verified. Nothing is left to implement.')
    if (report.onCommandsAlone.length > 0) {
      lines.push(`${report.onCommandsAlone.join(', ')}: verified on the commands alone, nothing fingerprinted; plan:status shows what their elements are at.`)
    }
  } else {
    const part = step.part ? ` (part ${step.part.index} of ${step.part.of})` : ''
    lines.push(`Next: ${step.id}${part}`, `  task: ${describeTask(step.task)} (${step.taskId})`, `  verify: ${step.verify.join(' → ')}`)
    const toImplement = step.elements.filter((element) => !element.waived)
    const waived = step.elements.flatMap((element) => (element.waived ? [`  ${element.id} (${element.section}): ${element.waived.reason} (${element.waived.at})`] : []))
    if (toImplement.length > 0) {
      lines.push('', 'Elements the step completes:')
      for (const element of toImplement) lines.push(`  ${element.id} (${element.section})`)
    }
    if (waived.length > 0) {
      lines.push('', 'Waived, not to be implemented:', ...waived, '  The step verifies without them; a waiver is the person\u2019s decision, not yours to take or to undo.')
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
      lines.push(
        '',
        `Stalled ${step.stalled.at}: ${step.stalled.reason}`,
        ...step.stalled.output.split('\n').map((line) => `  ${line}`),
        'A stall is a person\u2019s decision: fix the environment, revise the plan, or accept an element incomplete with',
        `  bunx guren plan:waive ${planArgument} <element-id> --reason "<why>"`,
      )
    }
    if (step.unjudged) {
      lines.push('', 'Depends on elements whose freshness could not be judged, which blocks nothing:')
      for (const element of step.unjudged) lines.push(`  ${element.verdict}  ${element.id}${element.reason ? `: ${element.reason}` : ''}`)
    }
    lines.push('', `Implement this step only, then run \`bunx guren plan:verify ${planArgument} --step ${step.id}\` and commit once it is verified.`, `Marked in ${report.stateFile}`)
  }
  lines.push(...blockedLines(report, planArgument))
  if (report.freshnessUnreadable) lines.push('', `The application could not be read, so no step was judged stale: ${report.freshnessUnreadable}`)
  if (report.decisionsUnreadable) lines.push('', `Decision log not read, so no waiver was applied: ${report.decisionsUnreadable}`)
  return lines.join('\n')
}
