/**
 * `guren plan:verify` (RFC 0030 §6): run a step's verify commands and tests against the
 * application, record the result under `.guren/plans/`, and report the plan's status with
 * that verification laid over it. Unlike `plan:status` it executes: `bun test` boots the
 * app and `db:migrate` opens the database.
 */

import { basename } from 'node:path'

import { isConfirmedApiOnlyApp } from './app-surface'
import { CliError } from './cli-error'
import { readScripts } from './command-output'
import { toPosixRelative } from './discovery'
import { readPlanFile } from './plan-render'
import { formatPlanStatus, type PlanStatusReport, PLAN_STATUS_REPORT_VERSION } from './plan-status'
import type { PlanAppState } from './plan/app-state'
import { approvedReadings, requirePlanApproval } from './plan/approvals'
import { judgeFreshness, type PlanFreshness } from './plan/freshness'
import { hasBaseline } from './plan/render'
import { describeDependency, HELD_STEP_REMEDY, judgeStepContext, stepInProgress, type PlanStepContext } from './plan/step-context'
import { planDigest, planSlug, readPlanState, writePlanStepRecord, type PlanStepRecord, type PlanStepWork } from './plan/state'
import { judgePlan, type PlanStatus } from './plan/status'
import { derivePlanTasks, findPlanStep, planStepIds } from './plan/tasks'
import { hashFiles, overlayVerification, readPlanWaivers, recordDrift, recordStillHolds, type PlanVerificationSummary } from './plan/verification'
import { PlanVerifier, type PlanStepVerification } from './plan/verify'
import { measureStepWork, stepWork } from './plan/work'
import { runCaptured } from './subprocess'

/** Per command. A migration or a suite past this is an environment to look at, not a slow step. */
export const DEFAULT_VERIFY_TIMEOUT_MS = 10 * 60 * 1000

export interface PlanVerifyReport extends PlanStatusReport {
  /** The steps this run verified, in the order they ran. */
  steps: PlanStepVerification[]
  /** Steps a whole-plan run left alone: verified before, at a fingerprint that still matches. */
  skipped: string[]
  /**
   * Steps verified before whose fingerprinted files changed since, re-checked and recorded here:
   * a drifted `--step` itself, the drifted steps before it once it verified, and in a whole-plan
   * run every drifted step once the others verified. A `tests:fail` step is re-checked without a
   * run ({@link PlanVerifier.recheckTests}).
   */
  reverified: string[]
  /**
   * Drifted steps this run left verified for a later one: not re-checked, since a step they share
   * commands with did not verify, or re-checked into `blocked` (the environment's) or into a
   * failed static re-check, which a run of `tests:fail` could never answer.
   */
  recheckPending: string[]
  verification: PlanVerificationSummary
  /**
   * The steps this run covered that depend on an element stale against the baseline (RFC
   * 0030 §4). Reported beside the outcome and never folded into it: `blocked` is the
   * environment's and `failed` the implementation's, and staleness is neither.
   */
  staleContext?: PlanStepContext[]
}

export interface PlanVerifyFileOptions {
  /** Loaded with `detail`; a function is called once, after `codegen` has run. */
  app: PlanAppState | (() => Promise<PlanAppState>)
  /** The application root: where the commands run and the state is written. */
  appRoot: string
  cwd?: string
  /** One step id; every step in task order when absent. */
  step?: string
  timeoutMs?: number
}

export async function planVerifyFile(planPath: string, options: PlanVerifyFileOptions): Promise<PlanVerifyReport> {
  const { path, plan } = await readPlanFile(planPath, options.cwd)
  // Judged on the plan this run read, never a caller's earlier reading: the file may have changed since.
  // Before anything runs or is recorded: a result about a hash nobody approved verifies nothing anyone agreed to.
  const approval = await requirePlanApproval(path, plan, 'no step is verified against it')
  const readings = approvedReadings(approval)
  const app = options.app
  const loadApp = typeof app === 'function' ? app : async () => app
  const root = options.appRoot
  // The app is not loaded before the first codegen: a load imports the routes file, and Bun
  // caches a failed import of a generated file for the process, codegen or no codegen.
  const derivation = derivePlanTasks(plan, { apiOnly: await isConfirmedApiOnlyApp(root).catch(() => false) })
  const digest = planDigest(plan)
  const slug = planSlug(path)

  const before = await readPlanState(root, slug)
  // Read once: the elements this run leaves out of a record and the ones its report lifts
  // must be the same set, and a second read could answer differently.
  const log = await readPlanWaivers(path, plan)
  let stepIds: string[]
  let rechecks: string[]
  const skipped: string[] = []
  const records = before.state?.steps ?? {}
  const hashes = await hashFiles(root, Object.values(records).flatMap((record) => Object.keys(record.fingerprint.files)))
  const drifted = (id: string): boolean => records[id] !== undefined && recordDrift(records[id], digest, hashes, log.waived).length > 0
  if (options.step === undefined) {
    // A whole-plan run redoes nothing that stands. The record lives in this checkout only, so a
    // fresh one has nothing to keep; a `tests` step run again under a revision passes on the red
    // runs its record carries (`carriedRedRuns()`), and without one it cannot pass once implemented.
    stepIds = planStepIds(derivation).filter((id) => {
      const record = records[id]
      if (record && recordStillHolds(record, digest, hashes, log.waived)) {
        skipped.push(id)
        return false
      }
      return true
    })
    rechecks = stepIds.filter(drifted)
    stepIds = stepIds.filter((id) => !drifted(id))
  } else if (findPlanStep(derivation, options.step)) {
    const ids = planStepIds(derivation)
    rechecks = ids.slice(0, ids.indexOf(options.step)).filter(drifted)
    stepIds = [options.step]
  } else {
    throw new CliError(`No step "${options.step}" is derived from this plan. The steps are:\n${planStepIds(derivation).map((id) => `  ${id}`).join('\n')}`)
  }

  // One app load answers both: the status after codegen, and freshness for a plan with a baseline.
  let judged: Promise<{ status: PlanStatus; freshness?: PlanFreshness }> | undefined
  const judge = () =>
    (judged ??= loadApp().then((loadedApp) => ({ status: judgePlan(plan, loadedApp, readings), ...(hasBaseline(plan) ? { freshness: judgeFreshness(plan, loadedApp) } : {}) })))
  const verifier = new PlanVerifier(plan, derivation, {
    root,
    planDigest: digest,
    status: async () => (await judge()).status,
    exec: runCaptured,
    timeoutMs: options.timeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS,
    scripts: await readScripts(root),
    waived: log.waived,
    previous: records,
  })
  const steps: PlanStepVerification[] = []
  const reverified: string[] = []
  const recheckPending: string[] = []
  const planFile = toPosixRelative(root, path)
  /**
   * Runs one step and records it unless it stays pending; true where it ran commands and did not
   * verify. Commands are shared across one run's steps, so a drifted step re-checked beside such a
   * one would inherit its failure.
   */
  const run = async (stepId: string): Promise<boolean> => {
    const record = records[stepId]
    const recheck = record !== undefined && drifted(stepId)
    const tests = findPlanStep(derivation, stepId)?.step.verify.includes('tests:fail') === true
    const statically = recheck && tests
    const ran = statically ? await verifier.recheckTests(stepId, record) : await verifier.verify(stepId)
    const work = await stepWork({
      stepId,
      planFile,
      active: before.state?.active,
      previous: record,
      outcome: ran.record.outcome,
      measure: (from) => measureStepWork(root, path, from),
    })
    const verification = { ...ran, record: { ...ran.record, work } }
    steps.push(verification)
    const verified = verification.record.outcome === 'verified'
    // A failed static re-check stays drifted: once recorded, the next run would ask a `tests:fail` it can never pass.
    if (recheck && (verification.record.outcome === 'blocked' || (statically && !verified))) recheckPending.push(stepId)
    else {
      await writePlanStepRecord(root, slug, stepId, verification.record)
      if (recheck) reverified.push(stepId)
    }
    return !statically && !verified
  }
  for (const stepId of stepIds) await run(stepId)
  let deferred = steps.some((step) => step.record.outcome !== 'verified')
  for (const stepId of rechecks) {
    if (deferred) recheckPending.push(stepId)
    else deferred = await run(stepId)
  }

  const overlaid = await overlayVerification(root, path, plan, await verifier.status(), derivation, { replacedUnreadable: before.unreadable, waivers: log })
  const { freshness } = await judge()
  const contexts = freshness ? judgeStepContext(plan, freshness, derivation, { inProgress: stepInProgress(before.state?.active) }) : new Map<string, PlanStepContext>()
  const staleContext = steps.map((step) => step.stepId).flatMap((id) => {
    const context = contexts.get(id)
    return context && context.stale.length > 0 ? [context] : []
  })
  return {
    reportVersion: PLAN_STATUS_REPORT_VERSION,
    plan: { file: basename(path), title: plan.title, hash: approval?.hash ?? null },
    ...overlaid.status,
    verification: overlaid.verification,
    steps,
    skipped,
    reverified,
    recheckPending,
    ...(freshness ? { freshness } : {}),
    ...(approval ? { approval } : {}),
    ...(staleContext.length > 0 ? { staleContext } : {}),
  }
}

/** `3 files (1 binary), +120 -8 since 1a2b3c4d5e6f`, or why the work was not measured. */
export function describeStepWork(work: PlanStepWork): string {
  if (!work.measured) return `not measured, ${work.reason}`
  const binary = work.files.filter((file) => file.added === null).length
  const files = `${work.files.length} ${work.files.length === 1 ? 'file' : 'files'}${binary > 0 ? ` (${binary} binary)` : ''}`
  return `${files}, +${work.added} -${work.removed} since ${work.from.slice(0, 12)}`
}

/** One step's record as `plan:verify` prints it; the Stop hook prints the same lines. */
export function formatPlanStepRecord(stepId: string, record: PlanStepRecord): string[] {
  const lines = [`${stepId}: ${record.outcome} (${record.durationMs} ms)`]
  for (const command of record.commands) {
    lines.push(`  ${command.status.padEnd('blocked'.length)}  ${command.command.padEnd('db:migrate'.length)}  ${command.label}`)
    if (command.reason) lines.push(`      ${command.reason}`)
    for (const finding of command.findings) lines.push(`      ${finding}`)
  }
  for (const behaviour of record.acceptance) lines.push(`  ${behaviour.status.padEnd('pending'.length)}  [${behaviour.id}]`)
  for (const element of record.incomplete) lines.push(`  not at its completion state: ${element}`)
  for (const element of record.waived) lines.push(`  waived, so not judged here: ${element}`)
  if (record.work) lines.push(`  work: ${describeStepWork(record.work)}`)
  return lines
}

export function formatPlanVerify(report: PlanVerifyReport): string {
  const lines: string[] = []
  const codegenFailed = report.steps.filter(({ record }) => record.commands.some((command) => command.command === 'codegen' && command.status !== 'pass'))
  for (const { stepId, record } of report.steps) {
    lines.push(...formatPlanStepRecord(stepId, record), '')
  }
  for (const context of report.staleContext ?? []) {
    const named = context.stale.map((element) => `${element.id} (${describeDependency(element)})`)
    lines.push(`${context.stepId}: depends on what changed since the plan was approved: ${named.join(', ')}; plan:next holds it until a person decides: ${HELD_STEP_REMEDY}`, '')
  }
  if (report.reverified.length > 0) lines.push(`Re-checked, since files they were verified at have changed: ${report.reverified.join(', ')}`, '')
  if (report.recheckPending.length > 0) {
    lines.push(`Left verified for a later run to re-check (a step they share commands with did not verify, the re-check was blocked, or a static re-check failed): ${report.recheckPending.join(', ')}`, '')
  }
  for (const stepId of report.skipped) lines.push(`${stepId}: verified before, and nothing it fingerprinted has changed`)
  if (report.skipped.length > 0) lines.push('')
  lines.push(`Recorded in ${report.verification.stateFile}`, '')
  if (codegenFailed.length > 0) {
    lines.push(`codegen did not pass in ${codegenFailed.map((step) => step.stepId).join(', ')}, so the status below was judged without the generated files.`, '')
  }
  // plan:verify runs only on an approved plan (or a draft), so the approval line would say nothing.
  lines.push(formatPlanStatus({ ...report, approval: undefined }))
  return lines.join('\n')
}
