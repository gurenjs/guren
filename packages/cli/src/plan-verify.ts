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
import { readPlanFile } from './plan-render'
import { formatPlanStatus, type PlanStatusReport, PLAN_STATUS_REPORT_VERSION } from './plan-status'
import type { PlanAppState } from './plan/app-state'
import { judgeFreshness, type PlanFreshness } from './plan/freshness'
import { planHash } from './plan/identity'
import { hasBaseline } from './plan/render'
import { describeDependency, judgeStepContext, stepInProgress, type PlanStepContext } from './plan/step-context'
import { planDigest, planSlug, readPlanState, writePlanStepRecord, type PlanStepRecord } from './plan/state'
import { judgePlan, type PlanStatus } from './plan/status'
import { derivePlanTasks, findPlanStep, planStepIds } from './plan/tasks'
import { hashFiles, overlayVerification, readPlanWaivers, recordStillHolds, type PlanVerificationSummary } from './plan/verification'
import { PlanVerifier, type PlanStepVerification } from './plan/verify'
import { runCaptured } from './subprocess'

/** Per command. A migration or a suite past this is an environment to look at, not a slow step. */
export const DEFAULT_VERIFY_TIMEOUT_MS = 10 * 60 * 1000

export interface PlanVerifyReport extends PlanStatusReport {
  /** The steps this run verified, in the order they ran. */
  steps: PlanStepVerification[]
  /** Steps a whole-plan run left alone: verified before, at a fingerprint that still matches. */
  skipped: string[]
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
  const skipped: string[] = []
  if (options.step === undefined) {
    // A whole-plan run redoes nothing that stands: the `tests` step must fail before its
    // implementation and cannot pass again once the `http` step has made the tests pass.
    // The record lives in this checkout only, so a fresh one has nothing to keep.
    const records = before.state?.steps ?? {}
    const hashes = await hashFiles(root, Object.values(records).flatMap((record) => Object.keys(record.fingerprint.files)))
    stepIds = planStepIds(derivation).filter((id) => {
      const record = records[id]
      if (record && recordStillHolds(record, digest, hashes, log.waived)) {
        skipped.push(id)
        return false
      }
      return true
    })
  } else if (findPlanStep(derivation, options.step)) {
    stepIds = [options.step]
  } else {
    throw new CliError(`No step "${options.step}" is derived from this plan. The steps are:\n${planStepIds(derivation).map((id) => `  ${id}`).join('\n')}`)
  }

  // One app load answers both: the status after codegen, and freshness for a plan with a baseline.
  let judged: Promise<{ status: PlanStatus; freshness?: PlanFreshness }> | undefined
  const judge = () =>
    (judged ??= loadApp().then((loadedApp) => ({ status: judgePlan(plan, loadedApp), ...(hasBaseline(plan) ? { freshness: judgeFreshness(plan, loadedApp) } : {}) })))
  const verifier = new PlanVerifier(plan, derivation, {
    root,
    planDigest: digest,
    status: async () => (await judge()).status,
    exec: runCaptured,
    timeoutMs: options.timeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS,
    scripts: await readScripts(root),
    waived: log.waived,
  })
  const steps: PlanStepVerification[] = []
  for (const stepId of stepIds) {
    const verification = await verifier.verify(stepId)
    await writePlanStepRecord(root, slug, stepId, verification.record)
    steps.push(verification)
  }

  const overlaid = await overlayVerification(root, path, plan, await verifier.status(), derivation, { replacedUnreadable: before.unreadable, waivers: log })
  const { freshness } = await judge()
  const contexts = freshness ? judgeStepContext(plan, freshness, derivation, { inProgress: stepInProgress(before.state?.active) }) : new Map<string, PlanStepContext>()
  const staleContext = stepIds.flatMap((id) => {
    const context = contexts.get(id)
    return context && context.stale.length > 0 ? [context] : []
  })
  return {
    reportVersion: PLAN_STATUS_REPORT_VERSION,
    plan: { file: basename(path), title: plan.title, hash: hasBaseline(plan) ? planHash(plan) : null },
    ...overlaid.status,
    verification: overlaid.verification,
    steps,
    skipped,
    ...(freshness ? { freshness } : {}),
    ...(staleContext.length > 0 ? { staleContext } : {}),
  }
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
    lines.push(`${context.stepId}: depends on what changed since the plan was approved: ${named.join(', ')}; plan:next holds it until the plan is revised and approved`, '')
  }
  for (const stepId of report.skipped) lines.push(`${stepId}: verified before, and nothing it fingerprinted has changed`)
  if (report.skipped.length > 0) lines.push('')
  lines.push(`Recorded in ${report.verification.stateFile}`, '')
  if (codegenFailed.length > 0) {
    lines.push(`codegen did not pass in ${codegenFailed.map((step) => step.stepId).join(', ')}, so the status below was judged without the generated files.`, '')
  }
  lines.push(formatPlanStatus(report))
  return lines.join('\n')
}
