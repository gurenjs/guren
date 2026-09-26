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
import { basename, resolve } from 'node:path'

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
import { PLAN_COMMAND_FORM, refusedPlanCommands } from './plan/command-allowlist'
import { planDecisionsPath, type PlanWaiver } from './plan/decisions'
import { judgeFreshness } from './plan/freshness'
import { hasBaseline } from './plan/render'
import { listPlanElements, type PlanAcceptance, type PlanDraft, type PlanElementSection } from './plan/schema'
import { describeDependency, HELD_STEP_REMEDY, judgeStepContext, stepInProgress, type PlanStepContext, type PlanStepContextElement } from './plan/step-context'
import { ensurePlanStateIgnored, PLAN_STATE_DIR, planDigest, planSlug, planStatePath, readPlanState, writePlanActiveStep, type PlanActiveStep, type PlanStall } from './plan/state'
import { planScaffoldCommandLine, planScaffoldCoverage, planScaffoldMountCommandLine, planScaffoldMounts } from './plan/scaffold'
import { derivePlanTasks, listPlanSteps, planLaterRelationships, type PlanDerivedStep, type PlanLaterRelationship, type PlanDerivedTask, type PlanTaskDerivation, type PlanTaskTitle } from './plan/tasks'
import { validatePlan, type PlanCheckResult } from './plan/validate'
import { hashFiles, readPlanWaivers, recordDrift, recordStillHolds, type PlanWaiversRead } from './plan/verification'
import { readStepStart } from './plan/work'
import { isRoutesFileMounted } from './routes-check'
import { pathExists } from './utils'

export const PLAN_NEXT_REPORT_VERSION = 1

export interface PlanNextElement {
  id: string
  section: PlanElementSection
  /** The plan's element, verbatim. */
  element: unknown
  /** Set where the decision log waives this element at the plan's hash: it is nobody's work. */
  waived?: { reason: string; at: string; by?: string }
}

/** A relationship by the plan's ids: the declaring model, its name and type, and its target. */
export interface PlanNextRelationship {
  model: string
  name: string
  type: PlanLaterRelationship['relationship']['type']
  target: string
}

export interface PlanNextStep extends Pick<PlanDerivedStep, 'id' | 'kind' | 'verify' | 'generates' | 'part'> {
  taskId: string
  task: PlanTaskTitle
  /** The elements the step completes. */
  elements: PlanNextElement[]
  /**
   * Relationships an earlier task's model declares that wait on this step's work (RFC 0030 §5,
   * Order): written in the declaring model's file, judged here.
   */
  relationships?: PlanNextRelationship[]
  /** The behaviours the step writes or must see pass. */
  acceptance: PlanAcceptance[]
  /** Where the Stop hook gave up on this step; cleared by this call, so the next run of the loop is asked again. */
  stalled?: PlanStall
  /** What the step depends on whose freshness is unstamped or unjudged (§4); it holds nothing. */
  unconfirmed?: PlanStepContextElement[]
  /** Set where the step was verified and only these fingerprinted files changed since: it is re-checked, not re-implemented. */
  drifted?: string[]
  /**
   * The plan hash the step was verified against, where that is not this one: after a revision,
   * the step is re-checked with `plan:verify` before anything is implemented.
   */
  verifiedAt?: string
  /** A scaffold step's: the command that writes it, the `generates` it writes, and those the `http` step writes by hand. A tests step's `writes` are its behaviours, one test skeleton each. */
  scaffold?: { command: string; writes: string[]; leaves: string[] }
  /**
   * The http step holding the routes a scaffold step wrote: the command that mounts their file,
   * the step's elements that scaffold wrote as stubs, and those it left to write by hand.
   */
  mount?: { command: string; file: string; scaffolded: string[]; byHand: string[] }
  /**
   * An http step's: the added or renamed views its actions render. `pages.gen.ts` names a page only once
   * its file exists, and the task's last http step typechecks, so each is written here as a stub the pages step completes.
   */
  pageStubs?: Array<{ view: string; page: string }>
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

function relationshipsOf(plan: PlanDraft, derivation: PlanTaskDerivation, stepId: string): Pick<PlanNextStep, 'relationships'> {
  const relationships = planLaterRelationships(plan, derivation)
    .filter((later) => later.stepId === stepId)
    .map((later) => ({ model: later.model.id, name: later.relationship.name, type: later.relationship.type, target: later.relationship.target }))
  return relationships.length > 0 ? { relationships } : {}
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

/** The step hands a plan's commands to the implementing agent as written, so one the allowlist refuses stops the whole plan (§8). */
function refuseDisallowedCommands(path: string, plan: PlanDraft): void {
  const refused = refusedPlanCommands(plan.commands).map(({ id, quoted, reason }) => `  ${id}: ${quoted} is refused: ${reason}`)
  if (refused.length === 0) return
  throw new CliError(
    `${basename(path)} carries commands the implementing agent would run as written, so no step of it is handed out:\n${refused.join('\n')}\n`
      + `A plan's commands are ${PLAN_COMMAND_FORM} naming a generator; fix them in the plan (plan:render shows each finding), and approve it again if it was approved.`,
  )
}

export async function planNextFile(planPath: string, options: PlanNextFileOptions): Promise<PlanNextReport> {
  const { path, plan } = await readPlanFile(planPath, options.cwd)
  // Before the tree is read or a step marked: an unapproved plan hands out no work, whatever else is wrong.
  const approval = await requirePlanApproval(path, plan, 'no step of it is handed out')
  // A draft passes the gate above without §2 having run, and an approval may predate the allowlist.
  refuseDisallowedCommands(path, plan)
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
  // dirty; so is the page `plan:render` writes beside the plan, with its temporaries. The plan and
  // its records, revisions included, are not: a waiver steers which step is returned. Excluded
  // by pathspec, since porcelain paths are relative to the repository root, not to `root`.
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
  // The step's work is measured from here (plan/work.ts), so marking the same step again keeps where it started.
  const from = previous?.step === step.id ? previous.from : ((await readStepStart(realRoot)) ?? null)
  const active: PlanActiveStep = resumed ?? {
    plan: toPosixRelative(root, path),
    step: step.id,
    startedAt: (options.now ?? (() => new Date()))().toISOString(),
    continuations: 0,
    ...(from !== undefined ? { from } : {}),
  }
  await writePlanActiveStep(root, slug, active)
  const unconfirmed = judged.contexts.get(step.id)?.unconfirmed ?? []
  const record = records[step.id]
  const drifted = record ? recordDrift(record, digest, hashes, log.waived) : []
  const verifiedAt = record?.outcome === 'verified' && record.planDigest !== digest ? record.planDigest : undefined
  // Named only while there is something to mount: a slice an older CLI scaffolded has no routes file.
  const mount = mountOf(plan, derivation, task, step, planPath)
  const mountable = mount && (await pathExists(resolve(root, mount.file))) && !(await isRoutesFileMounted(root, mount.file)) ? { mount } : {}

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
      ...relationshipsOf(plan, derivation, step.id),
      acceptance: plan.tasks.flatMap((intent) => intent.acceptance).filter((behaviour) => behaviours.has(behaviour.id)),
      ...stallOf(step.id),
      ...(unconfirmed.length > 0 ? { unconfirmed } : {}),
      ...(drifted.length > 0 ? { drifted } : {}),
      ...(verifiedAt === undefined ? {} : { verifiedAt }),
      ...(step.kind === 'scaffold' || step.kind === 'tests' ? { scaffold: scaffoldOf(plan, step, planPath) } : {}),
      ...mountable,
      ...pageStubsOf(plan, step),
    },
  }
}

function pageStubsOf(plan: PlanDraft, step: PlanDerivedStep): Pick<PlanNextStep, 'pageStubs'> {
  if (step.kind !== 'http') return {}
  const owned = new Set(step.elementIds)
  const views = new Set<string>()
  for (const controller of plan.controllers) {
    for (const action of controller.actions) {
      if (owned.has(action.id) && action.response.kind === 'inertia') views.add(action.response.view)
    }
  }
  const pageStubs = plan.views
    .filter((view) => views.has(view.id) && (view.change.kind === 'add' || view.change.kind === 'rename'))
    .map((view) => ({ view: view.id, page: view.page }))
  return pageStubs.length > 0 ? { pageStubs } : {}
}

function scaffoldOf(plan: PlanDraft, step: PlanDerivedStep, planArgument: string): NonNullable<PlanNextStep['scaffold']> {
  const command = planScaffoldCommandLine(planArgument, step.id)
  if (step.kind === 'tests') return { command, writes: [...step.acceptanceIds], leaves: [] }
  const { emitted, left } = planScaffoldCoverage(plan, step)
  return { command, writes: emitted, leaves: left.map((element) => element.id) }
}

function mountOf(plan: PlanDraft, derivation: PlanTaskDerivation, task: PlanDerivedTask, step: PlanDerivedStep, planArgument: string): PlanNextStep['mount'] {
  const mount = planScaffoldMounts(plan, derivation).find((candidate) => candidate.httpStep === step.id)
  const scaffold = task.steps.find((candidate) => candidate.id === mount?.scaffoldStep)
  if (!mount || !scaffold) return undefined
  const written = new Set(planScaffoldCoverage(plan, scaffold).emitted)
  return {
    command: planScaffoldMountCommandLine(planArgument, step.id),
    file: mount.path,
    scaffolded: step.elementIds.filter((id) => written.has(id)),
    byHand: step.elementIds.filter((id) => !written.has(id)),
  }
}

/** The command is spelled with the plan argument the text is formatted for, as the scaffold step's is. */
function mountLines(step: PlanNextStep, mount: NonNullable<PlanNextStep['mount']>, planArgument: string): string[] {
  return [
    `Mount the routes the scaffold step wrote first, with \`${planScaffoldMountCommandLine(planArgument, step.id)}\`, not by hand: it calls ${mount.file} from the entry registrar.`,
    ...(mount.scaffolded.length > 0 ? [`  Written as stubs by plan:scaffold, to finish: ${mount.scaffolded.join(', ')}. Each action validates and authorizes as planned and answers 501; write its body and response.`] : []),
    ...(mount.byHand.length > 0 ? [`  Not written by plan:scaffold, to write by hand: ${mount.byHand.join(', ')}.`] : []),
  ]
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

/** plan:scaffold refuses a draft, so a draft's step names the approval first. */
function scaffoldLines(step: PlanNextStep, scaffold: NonNullable<PlanNextStep['scaffold']>, draft: boolean, planArgument: string): string[] {
  const command = planScaffoldCommandLine(planArgument, step.id)
  const lines = draft
    ? [`Approve the plan first (bunx guren plan:approve ${planArgument}): plan:scaffold writes this step from an approved plan only, as`, `  ${command}`]
    : [step.kind === 'tests' ? `Write this step\u2019s test skeletons with \`${command}\`, not by hand, then fill them in.` : `Write this step with \`${command}\`, not by hand.`]
  if (step.kind === 'tests') {
    lines.push(
      `  It writes one TestApp test per behaviour (${scaffold.writes.join(', ')}), with its request and the expectations the plan states, into one file.`,
      '  Each fails at a given() call until the setup it names is written (records, the signed-in actor, path parameters); replace every call, and keep each title\u2019s id and its request.',
    )
    return lines
  }
  if (scaffold.writes.length > 0) {
    lines.push(
      `  It writes each added model (table and class), its validators and resources, each policy with a provider registering it, each added controller with its actions as stubs, the routes to them in a file of their own that the http step mounts, and the side-effect classes: ${scaffold.writes.join(', ')}`,
    )
  }
  if (scaffold.leaves.length > 0) lines.push(`  It does not write ${scaffold.leaves.join(', ')}; the http step implements them by hand.`)
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
    if (step.relationships) {
      lines.push('', 'Relationships of earlier models the step completes, declared in those models\u2019 files:')
      for (const relationship of step.relationships) lines.push(`  ${relationship.model} ${relationship.name} (${relationship.type} ${relationship.target})`)
    }
    if (waived.length > 0) {
      lines.push('', 'Waived, not to be implemented:', ...waived, '  The step verifies without them; a waiver is the person\u2019s decision, not yours to take or to undo.')
    }
    // A step verified before the revision was scaffolded then, and plan:scaffold refuses targets that exist.
    if (step.scaffold && !step.verifiedAt) {
      lines.push('', ...scaffoldLines(step, step.scaffold, report.plan.hash === null, planArgument))
    }
    // A draft is never scaffolded (plan:scaffold refuses it), so it has nothing to mount.
    if (step.mount && report.plan.hash !== null) lines.push('', ...mountLines(step, step.mount, planArgument))
    if (step.pageStubs) {
      lines.push(
        '',
        'Pages its actions render, which the pages step writes: create each now as a stub with a default export and the plan\u2019s Props, so codegen names it in .guren/pages.gen.ts and the typecheck passes. Leave the rest of the page to the pages step.',
        ...step.pageStubs.map((stub) => `  ${stub.page} (${stub.view})`),
      )
    }
    if (step.acceptance.length > 0) {
      lines.push('', `Behaviours${step.kind === 'tests' ? ' to write, as test titles `[<id>] <description>`, failing' : ' that must pass'}:`)
      for (const behaviour of step.acceptance) {
        lines.push(`  [${behaviour.id}] ${behaviour.description}`)
        lines.push(`      ${behaviour.kind}; actor ${behaviour.actor}; route ${behaviour.route}${behaviour.given.length ? `; given ${behaviour.given.join(', ')}` : ''}; expect ${describeExpectation(behaviour)}`)
      }
      if (step.kind === 'tests') {
        lines.push('  Each test requests its route through a TestApp, in its body or a function of its file it calls: plan:verify reads the requests before it runs them.')
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
      lines.push('', `Verified before; files it was verified at have changed since: ${step.drifted.join(', ')}.`, `Re-check it with \`${verify}\` rather than re-implementing it, fix only what that run reports, and commit once it is verified.`)
    } else if (step.verifiedAt) {
      lines.push(
        '',
        `Verified against plan hash ${step.verifiedAt.slice(0, 12)}, before the plan changed to this one.`,
        `Re-check it with \`${verify}\` before implementing anything: implement only what that run reports against the revised plan, and commit once it is verified.`,
      )
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
