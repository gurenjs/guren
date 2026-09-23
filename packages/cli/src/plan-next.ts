/**
 * `guren plan:next` (RFC 0030 §7): the next step of a plan to implement, with what that step
 * needs and nothing of the rest, and the mark the Stop hook reads to know which step a
 * session is on. It spawns no command: the records under `.guren/plans/` say what is
 * verified, the plan says what the step covers. A plan with a baseline also has the app read
 * (the routes file is imported), so a step on stale context (§4) is held and named.
 * A dirty tree is refused unless it is the marked step's own work: one step is one commit, and a
 * plan with a baseline no approval names is refused before anything is read or marked (§4).
 */

import { realpath } from 'node:fs/promises'
import { basename } from 'node:path'

import { isConfirmedApiOnlyApp } from './app-surface'
import { runGit } from './changed-files'
import { CliError } from './cli-error'
import { toPosixRelative } from './discovery'
import { readPlanFile } from './plan-render'
import { planStatusFile } from './plan-status'
import { loadPlanAppState, type PlanAppState } from './plan/app-state'
import { requirePlanApproval, type PlanApprovedStanding } from './plan/approvals'
import { planBesideExclusions } from './plan/beside'
import { describeCloseBlockers, formatCloseBlocker, type CloseBlocker } from './plan/close-remedy'
import { planDecisionsPath, type PlanWaiver } from './plan/decisions'
import { judgeFreshness } from './plan/freshness'
import { hasBaseline } from './plan/render'
import { listPlanElements, type PlanAcceptance, type PlanDraft, type PlanElementSection } from './plan/schema'
import { describeDependency, HELD_STEP_REMEDY, judgeStepContext, stepInProgress, type PlanStepContext, type PlanStepContextElement } from './plan/step-context'
import { ensurePlanStateIgnored, PLAN_STATE_DIR, planDigest, planSlug, planStatePath, readPlanState, writePlanActiveStep, type PlanActiveStep, type PlanStall } from './plan/state'
import { derivePlanTasks, listPlanSteps, type PlanDerivedStep, type PlanDerivedTask, type PlanTaskDerivation, type PlanTaskTitle } from './plan/tasks'
import { validatePlan, type PlanCheckResult } from './plan/validate'
import { hashFiles, readPlanWaivers, recordDrift, recordStillHolds, type PlanWaiversRead } from './plan/verification'

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
  /** What the step depends on whose freshness is unstamped or unjudged (§4); it holds nothing. */
  unconfirmed?: PlanStepContextElement[]
  /** Set where the step was verified and only these fingerprinted files changed since: it is re-checked, not re-implemented. */
  drifted?: string[]
}

export interface PlanNextStaleElement extends PlanStepContextElement {
  /** The §2 checks re-run for the element against the application as it reads now; passes left out. */
  checks: Array<Pick<PlanCheckResult, 'key' | 'status' | 'message'>>
}

/** A step held because what it depends on changed since approval (RFC 0030 §4). */
export interface PlanNextHeldStep {
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
  /** `null` when every step is verified, or every one left is held or waits on one that is. */
  step: PlanNextStep | null
  /** In task order; always empty for a draft, which has no baseline to be stale against. */
  held: PlanNextHeldStep[]
  /** Steps behind a held one: later in its task, or in a task waiting for it. */
  waiting: Array<{ id: string; on: string[]; stalled?: PlanStall }>
  /** Relative to the application root, POSIX separators. */
  stateFile: string
  /** The decision log beside the plan, relative to the application root; it need not exist. */
  decisionsFile: string
  /** Set when a decision log exists and would not read, so no waiver was applied to this report. */
  decisionsUnreadable?: string
  /** Set when the application could not be read for a plan with a baseline, so no step was held. */
  freshnessUnreadable?: string
  /**
   * With every step verified: the elements `plan:status` still does not count as verified or
   * waived, which `plan:close` refuses, each as its refusal prints it. Absent while a step is left.
   */
  unverified?: CloseBlocker[]
  /** Set when every step is verified and the application could not be read to list `unverified`. */
  unverifiedUnreadable?: string
}

export interface PlanNextFileOptions {
  appRoot: string
  /** Read only for a plan with a baseline. Defaults to {@link loadPlanAppState} without `detail`. */
  app?: PlanAppState | (() => Promise<PlanAppState>)
  cwd?: string
  now?: () => Date
  /** Read once every step is verified, for `unverified`. Defaults to {@link loadPlanAppState} with `detail`. */
  statusApp?: PlanAppState | (() => Promise<PlanAppState>)
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
 * A load that throws holds nothing: it is not evidence that anything changed.
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
  return { contexts: judgeStepContext(plan, judgeFreshness(plan, app), derivation, { inProgress }), app }
}

/** What `plan:close` would still refuse once every step is verified; a load that throws is reported, never fatal. */
async function unverifiedElements(
  path: string,
  plan: PlanDraft,
  derivation: PlanTaskDerivation,
  root: string,
  options: PlanNextFileOptions & { planArgument: string },
  waivers: PlanWaiversRead,
  approval: PlanApprovedStanding | undefined,
): Promise<Pick<PlanNextReport, 'unverified' | 'unverifiedUnreadable'>> {
  try {
    const status = await planStatusFile(path, { app: options.statusApp ?? (() => loadPlanAppState(root, { detail: true })), appRoot: root, read: { path, plan }, waivers, approval })
    const open = status.elements.filter((element) => element.change !== 'existing' && element.state !== 'verified' && element.state !== 'waived')
    return { unverified: describeCloseBlockers(plan, derivation, open, options.planArgument) }
  } catch (error) {
    return { unverifiedUnreadable: error instanceof Error ? error.message : String(error) }
  }
}

export async function planNextFile(planPath: string, options: PlanNextFileOptions): Promise<PlanNextReport> {
  const { path, plan } = await readPlanFile(planPath, options.cwd)
  // Before the tree is read or a step marked: an unapproved plan hands out no work, whatever else is wrong.
  const approval = await requirePlanApproval(path, plan, 'no step of it is handed out')
  const root = options.appRoot
  const derivation = derivePlanTasks(plan, { apiOnly: await isConfirmedApiOnlyApp(root).catch(() => false) })
  const digest = planDigest(plan)
  const slug = planSlug(path)
  const state = (await readPlanState(root, slug)).state
  const records = state?.steps ?? {}
  // A stall the approval gate recorded is answered by passing that gate, which this run just did:
  // it is not reported, and the step starts over on a fresh mark like any other stall's.
  const marked = state?.active
  const answered = marked?.stalled?.cause === 'approval'
  const previous = answered ? { ...marked, stalled: undefined } : marked
  const hashes = await hashFiles(root, Object.values(records).flatMap((record) => Object.keys(record.fingerprint.files)))
  const log = await readPlanWaivers(path, plan)
  // With every record standing nothing can be held, and the one read left is the detail load below.
  const allStand = listPlanSteps(derivation).every(({ step }) => {
    const record = records[step.id]
    return record !== undefined && recordStillHolds(record, digest, hashes, log.waived)
  })
  const judged = allStand ? { contexts: new Map<string, PlanStepContext>() } : await stepContexts(plan, derivation, options, stepInProgress(previous))
  const stallOf = (stepId: string): { stalled?: PlanStall } => (previous?.step === stepId && previous.stalled ? { stalled: previous.stalled } : {})

  const verified: string[] = []
  const onCommandsAlone: string[] = []
  const held: PlanNextHeldStep[] = []
  const waiting: PlanNextReport['waiting'] = []
  // A held step holds the rest of its task and every task waiting for it: a step depends on the ones before it.
  const heldBy = new Map<string, Set<string>>()
  let next: { task: PlanDerivedTask; step: PlanDerivedStep } | undefined
  for (const entry of listPlanSteps(derivation)) {
    const { task, step } = entry
    let behind = heldBy.get(task.id)
    if (!behind) {
      behind = new Set(task.dependsOn.flatMap((id) => [...(heldBy.get(id) ?? [])]))
      heldBy.set(task.id, behind)
    }
    const record = records[step.id]
    if (record && recordStillHolds(record, digest, hashes, log.waived)) {
      verified.push(step.id)
      if (Object.keys(record.fingerprint.files).length === 0) onCommandsAlone.push(step.id)
      continue
    }
    const stale = judged.contexts.get(step.id)?.stale ?? []
    if (stale.length > 0) {
      held.push({
        id: step.id,
        taskId: task.id,
        stale: stale.map((element) => ({ ...element, checks: [] })),
        ...stallOf(step.id),
      })
      behind.add(step.id)
    } else if (behind.size > 0) {
      waiting.push({ id: step.id, on: [...behind], ...stallOf(step.id) })
    } else {
      next ??= entry
    }
  }

  // Re-run only when something is held, on the load the holds were judged on.
  if (held.length > 0 && judged.app) {
    const checks = validatePlan(plan, judged.app).filter((result) => result.status !== 'pass')
    for (const element of held.flatMap((step) => step.stale)) {
      element.checks = checks.filter((result) => result.elementId === element.id).map(({ key, status, message }) => ({ key, status, message }))
    }
  }

  const head = {
    reportVersion: PLAN_NEXT_REPORT_VERSION,
    plan: { file: basename(path), title: plan.title, hash: approval?.hash ?? null },
    verified,
    onCommandsAlone,
    held,
    waiting,
    stateFile: toPosixRelative(root, planStatePath(root, slug)),
    decisionsFile: toPosixRelative(root, planDecisionsPath(path)),
    ...(log.unreadable ? { decisionsUnreadable: log.unreadable } : {}),
    ...(judged.unreadable ? { freshnessUnreadable: judged.unreadable } : {}),
  } satisfies Omit<PlanNextReport, 'step'>
  if (next === undefined) {
    // A stall sticks until a plan:next returns its step (§7); only a mark with nothing to report goes.
    const reported = [...held, ...waiting].some((step) => step.stalled !== undefined)
    if (previous && !reported) await writePlanActiveStep(root, slug, undefined)
    if (held.length > 0 || waiting.length > 0) return { ...head, step: null }
    return { ...head, step: null, ...(await unverifiedElements(path, plan, derivation, root, { ...options, planArgument: planPath }, log, approval)) }
  }
  const { task, step } = next

  // The state files are git-ignored before the tree is read, and excluded from the reading for a
  // checkout that tracked them before, so neither an earlier run's write nor the mark makes it
  // dirty; so is the page `plan:render` writes beside the plan, with its temporaries, which the
  // plan commands write. The plan and its records are not: a waiver steers which step is returned.
  // Excluded by pathspec, since porcelain paths are relative to the repository root, not to `root`.
  await ensurePlanStateIgnored(root)
  const [realRoot, realPlan] = await Promise.all([realpath(root), realpath(path)])
  const dirty =
    (await runGit(realRoot, [
      'status',
      '--porcelain',
      '--untracked-files=all',
      '--',
      '.',
      ...planBesideExclusions(realRoot, realPlan, { records: false }),
      `:(exclude,glob)${PLAN_STATE_DIR}/*.state.json`,
      `:(exclude)${PLAN_STATE_DIR}/.gitignore`,
    ])) ?? []
  if (dirty.length > 0 && previous?.step !== step.id) {
    const markedHeld = held.some((entry) => entry.id === previous?.step)
    throw new CliError(
      `The working tree under ${root} has uncommitted changes (paths relative to the repository root), and one step is one commit. Commit or discard them first:\n${dirty
        .slice(0, 10)
        .map((line) => `  ${line}`)
        .join('\n')}${dirty.length > 10 ? `\n  … and ${dirty.length - 10} more` : ''}${
        markedHeld ? `\nThe marked step ${previous!.step} is held: what it depends on changed since the plan was approved (plan:status names it).` : ''
      }`,
    )
  }

  const behaviours = new Set(step.acceptanceIds)
  // A stall is what the last session ended on: reported once, then the hook is asked again.
  const resumed = previous && previous.step === step.id && !previous.stalled && !answered ? previous : undefined
  const active: PlanActiveStep = resumed ?? {
    plan: toPosixRelative(root, path),
    step: step.id,
    startedAt: (options.now ?? (() => new Date()))().toISOString(),
    continuations: 0,
  }
  await writePlanActiveStep(root, slug, active)
  const unconfirmed = judged.contexts.get(step.id)?.unconfirmed ?? []
  const record = records[step.id]
  const drifted = record ? recordDrift(record, digest, hashes, log.waived) : []

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
      ...stallOf(step.id),
      ...(unconfirmed.length > 0 ? { unconfirmed } : {}),
      ...(drifted.length > 0 ? { drifted } : {}),
    },
  }
}

/** A multi-line text under a line that already carries its first line. */
function indent(text: string, pad: string): string {
  return text.split('\n').join(`\n${pad}`)
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

function heldLines(report: PlanNextReport, planArgument: string): string[] {
  if (report.held.length === 0) return []
  const lines = ['', 'Held, since what they depend on changed after the plan was approved:']
  for (const held of report.held) {
    lines.push(`  ${held.id}`)
    for (const element of held.stale) {
      lines.push(`    ${element.id} (${element.section}, ${element.change}), ${describeDependency(element)}: ${element.reason ?? 'stale'}`)
      if (element.checks.length === 0) lines.push('      the reference checks pass for it against the application as it reads now')
      for (const check of element.checks) lines.push(`      ${check.status}  ${check.message}`)
    }
    if (held.stalled) lines.push(`    stalled ${held.stalled.at}: ${indent(held.stalled.reason, '      ')}`)
  }
  if (report.waiting.length > 0) {
    lines.push('', 'Waiting on a held step:')
    for (const entry of report.waiting) {
      lines.push(`  ${entry.id} (on ${entry.on.join(', ')})`)
      if (entry.stalled) lines.push(`    stalled ${entry.stalled.at}: ${indent(entry.stalled.reason, '      ')}`)
    }
  }
  lines.push(
    '',
    `A held step is a person\u2019s decision: ${HELD_STEP_REMEDY}:`,
    `  bunx guren plan:approve ${planArgument}`,
    '  Approval keeps the baseline the plan was first stamped with. Commit the edited plan and its approvals file before the next plan:next, which refuses them uncommitted.',
  )
  return lines
}

export function formatPlanNext(report: PlanNextReport, planArgument: string): string {
  const lines = [`${report.plan.title} (${report.plan.file})`, '']
  if (report.verified.length > 0) lines.push(`Verified: ${report.verified.join(', ')}`, '')
  const step = report.step
  if (step === null && report.held.length > 0) {
    lines.push('No step can be returned: every step left is held, or waits on one that is. A person decides how the plan meets the application now.')
  } else if (step === null) {
    const open = report.unverified ?? []
    if (report.unverifiedUnreadable) {
      lines.push(`Every step is verified. The elements were not judged, so plan:status may still list some that plan:close refuses: ${report.unverifiedUnreadable}`)
    } else if (open.length > 0) {
      lines.push('Every step is verified, and these elements are not: plan:close refuses the plan until each is verified or waived.')
      lines.push(...open.map(formatCloseBlocker))
    } else {
      lines.push('Every step is verified. Nothing is left to implement.')
    }
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
    if (step.generates.length > 0) {
      lines.push(
        '',
        `The elements a scaffold would generate: ${step.generates.join(', ')}`,
        '  No generator for this step ships yet, so it completes on its verify commands; the steps after it implement these elements.',
      )
    }
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
        `Stalled ${step.stalled.at}: ${indent(step.stalled.reason, '  ')}`,
        ...(step.stalled.output ? [`  ${indent(step.stalled.output, '  ')}`] : []),
        'A stall is a person\u2019s decision: fix the environment, edit the plan (and approve it), or accept an element incomplete with',
        `  bunx guren plan:waive ${planArgument} <element-id> --reason "<why>"`,
      )
    }
    if (step.unconfirmed) {
      lines.push('', 'Depends on elements whose freshness is not confirmed, which holds nothing:')
      for (const element of step.unconfirmed) lines.push(`  ${element.verdict}  ${element.id}${element.reason ? `: ${element.reason}` : ''}`)
    }
    const verify = `bunx guren plan:verify ${planArgument} --step ${step.id}`
    if (step.drifted) {
      lines.push('', `Verified before; a later step changed files it was verified at: ${step.drifted.join(', ')}.`, `Re-check it with \`${verify}\` rather than re-implementing it, fix only what that run reports, and commit once it is verified.`)
    } else {
      lines.push('', `Implement this step only, then run \`${verify}\` and commit once it is verified.`)
    }
    lines.push(`Marked in ${report.stateFile}`)
  }
  lines.push(...heldLines(report, planArgument))
  if (report.freshnessUnreadable) {
    lines.push('', `The application could not be read, so no step was held: ${report.freshnessUnreadable}`, 'On a fresh clone, run `bunx guren codegen` first: the routes file imports the generated files.')
  }
  if (report.decisionsUnreadable) lines.push('', `Decision log not read, so no waiver was applied: ${report.decisionsUnreadable}`)
  return lines.join('\n')
}
