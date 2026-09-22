/**
 * `guren plan:approve` (RFC 0030 §4): the one place a plan's `baseline` is stamped, and the
 * record of its approval beside it. A draft gets `rev` and `contextHash` once, here; a plan
 * that already carries a baseline (a revision carries its parent's) is never restamped,
 * since the baseline is inside the hash every approval and waiver names.
 * It refuses while a §2 check fails or a question is open: silence approves nothing.
 */

import { basename, resolve } from 'node:path'

import { runGit } from './changed-files'
import { CliError, formatSchemaIssues } from './cli-error'
import { toPosixRelative } from './discovery'
import { readPlanFile } from './plan-render'
import type { PlanAppState } from './plan/app-state'
import { planApprovalsPath, readPlanApprovals, recordPlanApproval, requireReadableApprovals, type PlanApproval } from './plan/approvals'
import { gitAuthor, writeFileAtomic } from './plan/beside'
import { planDecisionsPath } from './plan/decisions'
import { stampContextHash, type PlanContextStamp } from './plan/freshness'
import { planHash } from './plan/identity'
import { hasBaseline } from './plan/render'
import { PlanSchema, type Plan } from './plan/schema'
import { PLAN_STATE_DIR } from './plan/state'
import { validatePlan } from './plan/validate'
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
}

export interface PlanApproveFileOptions {
  /** Resolved after the plan parses. */
  app: PlanAppState | (() => Promise<PlanAppState>)
  /** Where `git rev-parse HEAD` and `git config` are asked, and what paths are reported relative to. */
  appRoot: string
  cwd?: string
  now?: () => Date
  exec?: CapturedExec
  /** Approve although a section other than validators could not be read, leaving its elements unstamped. */
  allowUnstamped?: boolean
}

export async function planApproveFile(planPath: string, options: PlanApproveFileOptions): Promise<PlanApproveReport> {
  const { path, plan, document } = await readPlanFile(planPath, options.cwd)
  const appRoot = resolve(options.appRoot)
  const exec = options.exec ?? runCaptured
  const app = typeof options.app === 'function' ? await options.app() : options.app

  const blockers = [
    ...validatePlan(plan, app)
      .filter((result) => result.status === 'fail')
      .map((result) => `  ${result.elementId ? `${result.elementId}: ` : ''}${result.message}`),
    ...plan.questions.map((question) => `  question ${question.id} is unanswered: ${question.question}`),
  ]
  if (blockers.length > 0) {
    throw new CliError(
      `${path} is not approved while a check fails or a question is open; an assumption nobody confirmed is not approved by silence.\n${blockers.join('\n')}`,
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
    await refuseDirtyTree(appRoot, path)
    const stamp = stampContextHash(plan, app)
    // Validators are never read, so they alone never refuse; any other section would stay unstamped for good.
    const unread = stamp.unstamped.filter((entry) => entry.sections.some((section) => section !== 'validators'))
    if (unread.length > 0 && !options.allowUnstamped) {
      const sections = [...new Set(unread.flatMap((entry) => entry.sections.filter((section) => section !== 'validators')))]
      throw new CliError(
        `The application's ${sections.join(', ')} could not be read, so these elements would get no context hash and never be judged fresh or stale:\n${unread
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
  const approval: PlanApproval = { hash, approvedAt: (options.now ?? (() => new Date()))().toISOString(), ...(by ? { approvedBy: by } : {}) }
  const recorded = await recordPlanApproval(path, approvals, approval)
  return {
    reportVersion: PLAN_APPROVE_REPORT_VERSION,
    plan: { file: basename(path), title: approved.title, hash },
    approvalsFile: toPosixRelative(appRoot, planApprovalsPath(path)),
    ...(stamped ? { stamped } : {}),
    approval: recorded.existing ?? approval,
    alreadyApproved: recorded.existing !== undefined,
  }
}

/**
 * `contextHash` reads the working tree and `rev` names a commit, so the two agree only on a
 * clean tree. The plan and its sibling records are excluded: approving writes them. Pathspecs
 * are relative to `appRoot`, which need not be the repository root.
 */
async function refuseDirtyTree(appRoot: string, planPath: string): Promise<void> {
  const inside = [planPath, planApprovalsPath(planPath), planDecisionsPath(planPath)]
    .map((file) => toPosixRelative(appRoot, file))
    .filter((file) => !file.startsWith('../'))
  const dirty =
    (await runGit(appRoot, ['status', '--porcelain', '--', '.', ...inside.map((file) => `:(exclude,literal)${file}`), `:(exclude)${PLAN_STATE_DIR}`])) ?? []
  if (dirty.length === 0) return
  throw new CliError(
    `The working tree under ${appRoot} has uncommitted changes (paths relative to the repository root), and the baseline hashes the tree against HEAD. Commit or discard them first:\n${dirty
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
  lines.push(
    report.alreadyApproved
      ? `Already approved at ${report.approval.approvedAt}; ${report.approvalsFile} was left alone.`
      : `Approved ${report.plan.hash}, recorded in ${report.approvalsFile}.`,
  )
  return lines.join('\n')
}
