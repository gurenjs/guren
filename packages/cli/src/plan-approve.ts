/**
 * `guren plan:approve` (RFC 0030 §4): the one place a plan's `baseline` is stamped, and the
 * record of its approval beside it. A draft gets `rev` and `contextHash` once, here; a plan
 * that already carries a baseline (a revision carries its parent's) is never restamped,
 * since the baseline is inside the hash every approval and waiver names.
 * It refuses while a §2 check fails or a question is open: silence approves nothing. On a
 * baselined plan, a finding the plan's own finished work explains is settled first.
 */

import { realpath } from 'node:fs/promises'
import { basename, resolve } from 'node:path'

import { CliError, formatSchemaIssues } from './cli-error'
import { toPosixRelative } from './discovery'
import { readPlanFile } from './plan-render'
import type { PlanAppState } from './plan/app-state'
import { approvalReadings, heldAlters, planApprovalsPath, readPlanApprovals, recordPlanApproval, requireReadableApprovals, type HeldAlter, type PlanApproval } from './plan/approvals'
import { gitAuthor, planBesideExclusions, writeFileAtomic } from './plan/beside'
import { stampContextHash, type PlanContextStamp } from './plan/freshness'
import { planHash } from './plan/identity'
import { behaviourCanReach } from './plan/reach'
import { hasBaseline } from './plan/render'
import { PlanSchema, type Plan, type PlanDraft } from './plan/schema'
import { PLAN_STATE_DIR } from './plan/state'
import { readAlterProperties } from './plan/status'
import { settleBuiltFindings, validatePlan } from './plan/validate'
import { runCaptured, type CapturedExec } from './subprocess'

export const PLAN_APPROVE_REPORT_VERSION = 1

/** What `--json` prints. */
export interface PlanApproveReport {
  reportVersion: typeof PLAN_APPROVE_REPORT_VERSION
  plan: { file: string; title: string; hash: string }
  /** Relative to the application root, POSIX separators. */
  approvalsFile: string
  /** Set when this run stamped the baseline and rewrote the plan file; absent when the plan carried one. */
  stamped?: { rev: string; elements: number; unstamped: PlanContextStamp['unstamped'] }
  approval: PlanApproval
  /** The hash was approved before, and nothing was written. */
  alreadyApproved: boolean
  /** Elements whose collision or absence did not refuse, since the application reads as the plan leaves them. */
  builtByPlan?: string[]
  /** `alter` elements whose readings (RFC 0030 §6) this run wrote to the approvals file, carried over or read now; absent when it wrote none. */
  readingsRecorded?: string[]
  /**
   * Advisory, never a refusal: `alter`s whose readable planned properties all held at approval,
   * judged on the approval entry's readings, so none of those can complete them. Absent when none.
   */
  heldAlters?: Array<HeldAlter & { message: string }>
}

export interface PlanApproveFileOptions {
  /**
   * Resolved after the plan parses. A plan with an `alter` needs it loaded with `detail`, or no
   * reading is recorded and a later approval has to record them.
   */
  app: PlanAppState | ((plan: PlanDraft) => Promise<PlanAppState>)
  /** Where `git rev-parse HEAD` and `git config` are asked, and what paths are reported relative to. */
  appRoot: string
  cwd?: string
  now?: () => Date
  exec?: CapturedExec
  /** Approve although a section could not be read, leaving its elements unstamped. */
  allowUnstamped?: boolean
}

export async function planApproveFile(planPath: string, options: PlanApproveFileOptions): Promise<PlanApproveReport> {
  const { path, plan, document } = await readPlanFile(planPath, options.cwd)
  const appRoot = resolve(options.appRoot)
  const exec = options.exec ?? runCaptured
  const app = typeof options.app === 'function' ? await options.app(plan) : options.app

  const settled = settleBuiltFindings(plan, app, validatePlan(plan, app))
  const blockers = [
    ...settled.checks
      .filter((result) => result.status === 'fail')
      .map((result) => `  ${result.elementId ? `${result.elementId}: ` : ''}${result.message}`),
    ...plan.questions.map((question) => `  question ${question.id} is unanswered: ${question.question}`),
  ]
  if (blockers.length > 0) {
    // The review page writes nothing, so a reader who answered there lands here with the plan unchanged.
    const answerHint =
      plan.questions.length > 0
        ? '\nAn answer chosen on the review page does not change the plan file. Send the agent the prompt the page copies with "Copy prompt for the agent", or remove each answered question yourself with plan:revise (--edited with a copy of the plan, or --ops with a remove op), passing the page\'s feedback with --feedback.'
        : ''
    throw new CliError(
      `${path} is not approved while a check fails or a question is open; an assumption nobody confirmed is not approved by silence.\n${blockers.join('\n')}${answerHint}`,
    )
  }
  // Read before anything is written, so a file that will not read leaves the plan file untouched too.
  const approvals = requireReadableApprovals(await readPlanApprovals(path))

  let approved: Plan
  let stamped: PlanApproveReport['stamped']
  if (hasBaseline(plan)) {
    approved = plan
  } else {
    const rev = await headRevision(appRoot, exec)
    await refuseDirtyTree(appRoot, path, exec)
    const stamp = stampContextHash(plan, app)
    // A baseline is never restamped, so an element left out here stays unstamped for good.
    if (stamp.unstamped.length > 0 && !options.allowUnstamped) {
      const sections = [...new Set(stamp.unstamped.flatMap((entry) => entry.sections))]
      throw new CliError(
        `The application's ${sections.join(', ')} could not be read, so these elements would get no context hash and never be judged fresh or stale:\n${stamp.unstamped
          .map((entry) => `  ${entry.id}: ${entry.reason}`)
          .join('\n')}\nFix what the reason names, or pass --allow-unstamped to approve without them.`,
      )
    }
    // The author's document plus the baseline, so an omitted section stays omitted in the file.
    const stampedDocument = { ...(document as Record<string, unknown>), baseline: { rev, contextHash: stamp.contextHash } }
    const parsed = PlanSchema.safeParse(stampedDocument)
    if (!parsed.success) throw new CliError(`The stamped plan does not match the plan schema:\n${formatSchemaIssues(parsed.error)}`)
    await writeFileAtomic(path, `${JSON.stringify(stampedDocument, null, 2)}\n`)
    approved = parsed.data
    stamped = { rev, elements: Object.keys(stamp.contextHash).length, unstamped: stamp.unstamped }
  }

  const hash = planHash(approved)
  const by = await gitAuthor(appRoot, exec)
  const current = readAlterProperties(approved, app)
  const readings = approvalReadings(approvals, approved, current)
  const approval: PlanApproval = {
    hash,
    approvedAt: (options.now ?? (() => new Date()))().toISOString(),
    ...(by ? { approvedBy: by } : {}),
    ...(readings.properties.length > 0 ? { readings } : {}),
  }
  const recorded = await recordPlanApproval(path, approvals, approval)
  const readingsRecorded = [...new Set(recorded.readingsAdded.map((reading) => reading.element))]
  const entry = recorded.existing ?? approval
  const reachable = behaviourCanReach(approved)
  const warnings = heldAlters(approved, current, entry.readings?.properties ?? []).map((alter) => ({ ...alter, message: heldAlterMessage(alter, reachable.has(alter.element)) }))
  return {
    reportVersion: PLAN_APPROVE_REPORT_VERSION,
    plan: { file: basename(path), title: approved.title, hash },
    approvalsFile: toPosixRelative(appRoot, planApprovalsPath(path)),
    ...(stamped ? { stamped } : {}),
    approval: entry,
    alreadyApproved: recorded.existing !== undefined,
    ...(settled.built.length > 0 ? { builtByPlan: settled.built } : {}),
    ...(readingsRecorded.length > 0 ? { readingsRecorded } : {}),
    ...(warnings.length > 0 ? { heldAlters: warnings } : {}),
  }
}

/** Agrees with `plan:status`'s `unjudged` reason and `plan:close`'s remedies: `reachable` is `behaviourCanReach()`. */
function heldAlterMessage(alter: HeldAlter, reachable: boolean): string {
  let shows = 'none shows the change'
  if (alter.unread.length > 0) {
    const which = alter.unread.length === 1 ? 'it' : 'one of them'
    shows = `${alter.unread.join(', ')} read unknown then, and only a match on ${which} can still show the change (a property no reader sees never matches)`
  } else if (alter.readNow) {
    shows += ', so plan:status reports it unjudged'
  } else {
    shows += ' (it is not read now, so this rests on the readings recorded at approval)'
  }
  const otherwise = reachable ? 'it completes only through a verified behaviour that reaches it, or by a waiver' : 'only a waiver completes it, since no behaviour can reach it'
  return `${alter.element} (${alter.label}): every readable planned property already held at approval (${alter.held.join(', ')}); ${shows}. State the change in a property the application does not hold yet and approve the plan again, or expect that ${otherwise}.`
}

/**
 * `contextHash` reads the working tree and `rev` names a commit, so the two agree only on a
 * clean tree. The plan, its page, its sibling records, a write's leftover temp file and the
 * state directory are excluded: approving and rendering write them. Pathspecs are relative
 * to `appRoot`, which need not be the repository root; both sides are real paths.
 */
async function refuseDirtyTree(appRoot: string, planPath: string, exec: CapturedExec): Promise<void> {
  const [root, plan] = await Promise.all([realpath(appRoot), realpath(planPath)])
  const excluded = planBesideExclusions(root, plan, { records: true })
  let run
  try {
    run = await exec(['git', 'status', '--porcelain', '--untracked-files=all', '--', '.', ...excluded, `:(exclude)${PLAN_STATE_DIR}`], root)
  } catch (error) {
    run = { exitCode: -1, stdout: '', stderr: (error as Error).message }
  }
  if (run.exitCode !== 0) {
    throw new CliError(`Cannot tell whether the working tree under ${root} is clean, so the baseline is not stamped: git status failed (${run.stderr.trim() || `exit ${run.exitCode}`}).`)
  }
  const dirty = run.stdout.split('\n').map((line) => line.trimEnd()).filter((line) => line.length > 0)
  if (dirty.length === 0) return
  throw new CliError(
    `The working tree under ${root} has uncommitted changes (paths relative to the repository root), and the baseline hashes the tree against HEAD. Commit or discard them first:\n${dirty
      .slice(0, 10)
      .map((line) => `  ${line}`)
      .join('\n')}${dirty.length > 10 ? `\n  … and ${dirty.length - 10} more` : ''}`,
  )
}

/** A rev that names no commit cannot be checked out later, so no repository and no commit are both refusals. */
async function headRevision(appRoot: string, exec: CapturedExec): Promise<string> {
  const refuse = (detail: string): never => {
    throw new CliError(
      `Cannot stamp the plan's baseline: ${appRoot} has no commit git can name (${detail}). baseline.rev records the commit the plan was written against; commit the application first.`,
    )
  }
  try {
    const run = await exec(['git', 'rev-parse', '--verify', 'HEAD'], appRoot)
    const rev = run.stdout.trim()
    if (run.exitCode !== 0 || rev.length === 0) return refuse(run.stderr.trim() || `git exited ${run.exitCode}`)
    return rev
  } catch (error) {
    return refuse((error as Error).message)
  }
}

export function formatPlanApprove(report: PlanApproveReport): string {
  const lines = [`${report.plan.title} (${report.plan.file})`, '']
  if (report.stamped) {
    lines.push(`Stamped the baseline at ${report.stamped.rev}: ${report.stamped.elements} element(s) hashed.`)
    if (report.stamped.unstamped.length > 0) {
      lines.push(`Not hashed, since their section could not be read: ${report.stamped.unstamped.map((entry) => entry.id).join(', ')}`)
    }
  }
  if (report.builtByPlan) {
    lines.push(`Built as the plan leaves them, so their collision or absence is the plan's own work: ${report.builtByPlan.join(', ')}`)
  }
  if (!report.alreadyApproved) {
    lines.push(`Approved ${report.plan.hash}, recorded in ${report.approvalsFile}.`)
  } else if (report.readingsRecorded) {
    lines.push(`Already approved at ${report.approval.approvedAt}; recorded the readings it lacked in ${report.approvalsFile}: ${report.readingsRecorded.join(', ')}.`)
  } else {
    lines.push(`Already approved at ${report.approval.approvedAt}; ${report.approvalsFile} was left alone.`)
  }
  if (report.heldAlters) {
    lines.push('', 'Warning, advisory (the approval stands):', ...report.heldAlters.map((alter) => `  ${alter.message}`))
  }
  return lines.join('\n')
}
