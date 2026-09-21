/**
 * `guren plan:verify` (RFC 0030 §6): run a step's verify commands and tests against the
 * application, record the result under `.guren/plans/`, and report the plan's status with
 * that verification laid over it. Unlike `plan:status` it executes: `bun test` boots the
 * app and `db:migrate` opens the database.
 */

import { basename } from 'node:path'

import { CliError } from './cli-error'
import { readScripts } from './command-output'
import { readPlanFile } from './plan-render'
import { formatPlanStatus, type PlanStatusReport, PLAN_STATUS_REPORT_VERSION } from './plan-status'
import type { PlanAppState } from './plan/app-state'
import { planHash } from './plan/identity'
import { hasBaseline } from './plan/render'
import { planDigest, planSlug, writePlanStepRecord } from './plan/state'
import { judgePlan } from './plan/status'
import { derivePlanTasks, findPlanStep, planStepIds } from './plan/tasks'
import { overlayVerification, type PlanVerificationSummary } from './plan/verification'
import { PlanVerifier, type PlanStepVerification } from './plan/verify'
import { runCaptured } from './subprocess'

/** Per command. A migration or a suite past this is an environment to look at, not a slow step. */
export const DEFAULT_VERIFY_TIMEOUT_MS = 10 * 60 * 1000

export interface PlanVerifyReport extends PlanStatusReport {
  /** The steps this run verified, in the order they ran. */
  steps: PlanStepVerification[]
  verification: PlanVerificationSummary
}

export interface PlanVerifyFileOptions {
  /** Loaded with `detail`. Resolved after the plan parses. */
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
  const app = typeof options.app === 'function' ? await options.app() : options.app
  const root = options.appRoot
  const status = judgePlan(plan, app)
  const derivation = derivePlanTasks(plan, { apiOnly: app.apiOnly })

  let stepIds: string[]
  if (options.step === undefined) {
    stepIds = planStepIds(derivation)
  } else if (findPlanStep(derivation, options.step)) {
    stepIds = [options.step]
  } else {
    throw new CliError(`No step "${options.step}" is derived from this plan. The steps are:\n${planStepIds(derivation).map((id) => `  ${id}`).join('\n')}`)
  }

  const verifier = new PlanVerifier(plan, status, derivation, {
    root,
    planDigest: planDigest(plan),
    exec: runCaptured,
    timeoutMs: options.timeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS,
    scripts: await readScripts(root),
  })
  const slug = planSlug(path)
  const steps: PlanStepVerification[] = []
  for (const stepId of stepIds) {
    const verification = await verifier.verify(stepId)
    await writePlanStepRecord(root, slug, stepId, verification.record)
    steps.push(verification)
  }

  const overlaid = await overlayVerification(root, path, plan, status, derivation)
  return {
    reportVersion: PLAN_STATUS_REPORT_VERSION,
    plan: { file: basename(path), title: plan.title, hash: hasBaseline(plan) ? planHash(plan) : null },
    ...overlaid.status,
    verification: overlaid.verification,
    steps,
  }
}

export function formatPlanVerify(report: PlanVerifyReport): string {
  const lines: string[] = []
  for (const { stepId, record } of report.steps) {
    lines.push(`${stepId}: ${record.outcome} (${record.durationMs} ms)`)
    for (const command of record.commands) {
      lines.push(`  ${command.status.padEnd('blocked'.length)}  ${command.command.padEnd('db:migrate'.length)}  ${command.label}`)
      if (command.reason) lines.push(`      ${command.reason}`)
      for (const finding of command.findings) lines.push(`      ${finding}`)
    }
    for (const behaviour of record.acceptance) lines.push(`  ${behaviour.status.padEnd('pending'.length)}  [${behaviour.id}]`)
    for (const element of record.incomplete) lines.push(`  not at its completion state: ${element}`)
    lines.push('')
  }
  lines.push(`Recorded in ${report.verification.stateFile}`, '')
  lines.push(formatPlanStatus(report))
  return lines.join('\n')
}
