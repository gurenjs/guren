/**
 * The plan half of the harness Stop hook (RFC 0030 §7): verify the step `plan:next` marked
 * and block the stop while it is not, giving up where a continuation cannot help: no approval
 * names the plan's hash, what the step depends on went stale since approval (§4), the step or
 * an element it owns is `blocked`, the record is the one the last continuation was blocked on,
 * or three continuations. A stall is recorded in state and sticks until the next `plan:next`.
 * `verify` is the seam the unit tests fake; the shipped hooks run `plan:verify`, whose report
 * carries the stale context, judged on the app it reads after `codegen`.
 */

import { resolve } from 'node:path'

import { isConfirmedApiOnlyApp } from './app-surface'
import { CliError } from './cli-error'
import { readPlanFile } from './plan-render'
import { formatPlanStepRecord, planVerifyFile, type PlanVerifyReport } from './plan-verify'
import { loadPlanAppState } from './plan/app-state'
import { describeUnapproved, readPlanApprovalStanding } from './plan/approvals'
import { describeDependency, type PlanStepContextElement } from './plan/step-context'
import { listPlanStates, planDigest, planSlug, writePlanActiveStep, type PlanActiveStep, type PlanStepRecord } from './plan/state'
import { derivePlanTasks, findPlanStep } from './plan/tasks'
import { hashFiles, readPlanWaivers, recordStillHolds, sha256 } from './plan/verification'

/** Stops the hook blocks on one step before it gives up. */
export const MAX_STEP_CONTINUATIONS = 3

export interface PlanStopHookInput {
  /** Whether this stop already follows one a Stop hook blocked. */
  stopHookActive: boolean
}

export interface PlanStopHookVerdict {
  /** Exit 2 for Claude Code and Codex, a follow-up for Cursor. */
  block: boolean
  message?: string
}

export interface PlanStopHookDeps {
  verify?: (planPath: string, appRoot: string, stepId: string) => Promise<PlanVerifyReport>
  now?: () => Date
}

export type StopHookJudgement = { kind: 'verified' } | { kind: 'continue'; signature: string } | { kind: 'stalled'; reason: string; signature: string }

/** What of a record a continuation could change; timings and the environment are not it. */
export function recordSignature(record: PlanStepRecord): string {
  return sha256(
    JSON.stringify({
      outcome: record.outcome,
      commands: record.commands.map(({ command, status, reason, findings }) => ({ command, status, reason, findings })),
      acceptance: record.acceptance,
      incomplete: record.incomplete,
      files: record.fingerprint.files,
    }),
  )
}

/**
 * Pure: whether the stop is blocked, let through as verified, or given up on, and why. `stale`
 * is the step's stale context: the plan does not describe the application there, so no
 * continuation can finish the step against it.
 */
export function judgeStopHook(
  active: PlanActiveStep,
  record: PlanStepRecord,
  blockedElements: ReadonlyArray<{ id: string; reason?: string }>,
  stopHookActive: boolean,
  stale: ReadonlyArray<Pick<PlanStepContextElement, 'id' | 'owned' | 'through' | 'within'>> = [],
): StopHookJudgement {
  if (record.outcome === 'verified') return { kind: 'verified' }
  const signature = recordSignature(record)
  const stalled = (reason: string): StopHookJudgement => ({ kind: 'stalled', reason, signature })
  if (stale.length > 0) {
    return stalled(`what the step depends on changed since the plan was approved (${stale.map((element) => `${element.id}, ${describeDependency(element)}`).join('; ')})`)
  }
  if (record.outcome === 'blocked') {
    const reasons = record.commands.filter((command) => command.status === 'blocked').map((command) => `${command.command}: ${command.reason ?? 'blocked'}`)
    return stalled(`the step is blocked (${reasons.join('; ')})`)
  }
  if (blockedElements.length > 0) {
    return stalled(blockedElements.map((element) => `${element.id} is blocked${element.reason ? ` (${element.reason})` : ''}`).join('; '))
  }
  if (stopHookActive && active.lastSignature === signature) return stalled('nothing about the step changed since the last continuation')
  if (active.continuations >= MAX_STEP_CONTINUATIONS) return stalled(`${MAX_STEP_CONTINUATIONS} continuations on this step`)
  return { kind: 'continue', signature }
}

function defaultVerify(planPath: string, appRoot: string, stepId: string): Promise<PlanVerifyReport> {
  return planVerifyFile(planPath, { app: () => loadPlanAppState(appRoot, { detail: true }), appRoot, step: stepId })
}

async function verifyActiveStep(appRoot: string, slug: string, records: Readonly<Record<string, PlanStepRecord>>, active: PlanActiveStep, stopHookActive: boolean, deps: PlanStopHookDeps): Promise<PlanStopHookVerdict> {
  const planPath = resolve(appRoot, active.plan)
  const heading = `plan:verify on stop (${active.plan}, ${active.step})`
  let plan
  try {
    plan = (await readPlanFile(planPath)).plan
  } catch (error) {
    // The mark outlived its plan: nothing to verify against, and the next plan:next rewrites it.
    return { block: false, message: `${heading}: ${error instanceof Error ? error.message : String(error)}\nRun \`bunx guren plan:next ${active.plan}\` again once the plan is back.` }
  }
  // plan:verify records under planSlug(); a mark in another file would never see them.
  if (planSlug(planPath) !== slug) {
    await writePlanActiveStep(appRoot, slug, undefined)
    return {
      block: false,
      message: `${heading}: the mark is in .guren/plans/${slug}.state.json, but this plan's records are kept in ${planSlug(planPath)}.state.json, so the mark was cleared. Run \`bunx guren plan:next ${active.plan}\` to mark the step again.`,
    }
  }
  const log = await readPlanWaivers(planPath, plan)
  // A log nobody could read is judged as if no waiver were taken, which may be what holds the step,
  // so every verdict below carries the notice: those that run nothing would otherwise drop it.
  const notice = log.unreadable ? `${heading}: ${log.unreadable}\nNo waiver was applied, so the step is judged as if none were taken.` : undefined
  const withNotice = (verdict: PlanStopHookVerdict): PlanStopHookVerdict =>
    notice === undefined ? verdict : { ...verdict, message: verdict.message ? `${notice}\n${verdict.message}` : notice }

  // A stall rather than a block: no continuation approves a plan. plan:next drops it once one does.
  const approval = await readPlanApprovalStanding(planPath, plan)
  if (approval && approval.state !== 'approved') {
    const reason = describeUnapproved(active.plan, approval, 'the step is not verified against it')
    const at = (deps.now ?? (() => new Date()))().toISOString()
    await writePlanActiveStep(appRoot, slug, { ...active, stalled: { at, reason, cause: 'approval' } })
    return withNotice({
      block: false,
      message: `${heading}: giving up, ${reason}\nThe step is recorded as stalled; \`bunx guren plan:next ${active.plan}\` returns it once an approval names the plan's hash.`,
    })
  }
  const digest = planDigest(plan)
  const derivation = derivePlanTasks(plan, { apiOnly: await isConfirmedApiOnlyApp(appRoot).catch(() => false) })
  const step = findPlanStep(derivation, active.step)?.step
  if (!step) {
    await writePlanActiveStep(appRoot, slug, undefined)
    return { block: false, message: `${heading}: the plan no longer derives this step, so the mark was cleared. Run \`bunx guren plan:next ${active.plan}\` for the next one.` }
  }
  const record = records[active.step]
  if (record && recordStillHolds(record, digest, await hashFiles(appRoot, Object.keys(record.fingerprint.files)), log.waived)) return withNotice({ block: false })

  let report: PlanVerifyReport
  try {
    report = await (deps.verify ?? defaultVerify)(planPath, appRoot, active.step)
  } catch (error) {
    // A run that could not judge the step is not a reason to hold the session: the hook says so and lets it stop.
    const reason = error instanceof CliError ? error.message : error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    return withNotice({ block: false, message: `${heading}: could not verify the step: ${reason}` })
  }
  const verification = report.steps.find((candidate) => candidate.stepId === active.step)
  if (!verification) return withNotice({ block: false, message: `${heading}: the run did not cover the step.` })
  const owned = new Set(step.elementIds)
  const blockedElements = report.elements.filter((element) => owned.has(element.id) && element.state === 'blocked')
  const stale = report.staleContext?.find((context) => context.stepId === active.step)?.stale ?? []
  const judgement = judgeStopHook(active, verification.record, blockedElements, stopHookActive, stale)
  if (judgement.kind === 'verified') {
    // Earlier steps are not this step's continuation: plan:next returns them once this one is done.
    const pending = new Set(report.recheckPending)
    // A failed static re-check is pending too, but it answered, so it is reported with the broken ones.
    const broken = report.steps.filter(({ stepId, record: earlier }) => (report.reverified.includes(stepId) || pending.has(stepId)) && earlier.outcome !== 'verified' && earlier.outcome !== 'blocked')
    const unchecked = report.steps.filter(({ stepId, record: earlier }) => pending.has(stepId) && earlier.outcome === 'blocked')
    const deferred = report.recheckPending.filter((stepId) => !report.steps.some((step) => step.stepId === stepId))
    if (broken.length === 0 && unchecked.length === 0 && deferred.length === 0) return withNotice({ block: false })
    const said: string[] = []
    if (broken.length > 0) {
      const lines = broken.flatMap(({ stepId, record: earlier }) => formatPlanStepRecord(stepId, earlier))
      const which = broken.length === 1 ? 'an earlier step' : `${broken.length} earlier steps`
      said.push(`${heading}: the step is verified, and its changes broke ${which}:\n${lines.join('\n')}\n\`bunx guren plan:next ${active.plan}\` returns ${broken.length === 1 ? 'it' : 'them'} next.`)
    }
    for (const { stepId, record: earlier } of unchecked) {
      const why = earlier.commands.filter((command) => command.status === 'blocked').map((command) => `${command.command}: ${command.reason ?? 'blocked'}`)
      said.push(`${heading}: ${stepId}, whose files changed since it verified, could not be re-checked (${why.join('; ')}); its record stays for the next run.`)
    }
    if (deferred.length > 0) {
      said.push(`${heading}: ${deferred.join(', ')}, whose files changed since ${deferred.length === 1 ? 'it' : 'they'} verified, ${deferred.length === 1 ? 'is' : 'are'} left for the next run to re-check, since an earlier re-check did not verify.`)
    }
    return withNotice({ block: false, message: said.join('\n') })
  }

  const output = formatPlanStepRecord(active.step, verification.record).join('\n')
  if (judgement.kind === 'stalled') {
    const at = (deps.now ?? (() => new Date()))().toISOString()
    await writePlanActiveStep(appRoot, slug, { ...active, lastSignature: judgement.signature, stalled: { at, reason: judgement.reason, output } })
    return withNotice({
      block: false,
      message: `${heading}: giving up, ${judgement.reason}.\n${output}\nThe step is recorded as stalled. Fix the environment, edit the plan (and approve it), or waive an element with \`bunx guren plan:waive ${active.plan} <element-id> --reason "<why>"\`; \`bunx guren plan:next ${active.plan}\` then returns it again.`,
    })
  }
  const continuations = active.continuations + 1
  await writePlanActiveStep(appRoot, slug, { ...active, continuations, lastSignature: judgement.signature })
  return withNotice({
    block: true,
    message: `${heading}: the step is ${verification.record.outcome}, so this turn is not done (continuation ${continuations} of ${MAX_STEP_CONTINUATIONS}).\n${output}\nFinish the step: it is done when \`bunx guren plan:verify ${active.plan} --step ${active.step}\` reports it verified.`,
  })
}

/** Every marked step under the application root, verified; one message covers them all. */
export async function planStopHookFindings(appRoot: string, input: PlanStopHookInput, deps: PlanStopHookDeps = {}): Promise<PlanStopHookVerdict> {
  const messages: string[] = []
  let block = false
  for (const { slug, state, unreadable } of await listPlanStates(appRoot)) {
    if (unreadable) messages.push(`plan:verify on stop: ${unreadable}\nThe next plan:verify replaces it, and its mark is gone: run \`bunx guren plan:next <plan>\` again.`)
    const active = state?.active
    if (!active || active.stalled) continue
    const verdict = await verifyActiveStep(appRoot, slug, state.steps, active, input.stopHookActive, deps)
    if (verdict.message) messages.push(verdict.message)
    block ||= verdict.block
  }
  return messages.length > 0 ? { block, message: messages.join('\n\n') } : { block }
}
