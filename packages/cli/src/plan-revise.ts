/**
 * `guren plan:revise` (RFC 0030 §4, Part 3): a revision with no model call. The plan file as it
 * stands is the parent; the change arrives separately, as ops (`--ops`) or as an edited copy whose
 * ops `diffPlans()` derives (`--edited`). `createPlanRevision()` stamps them, the record is written
 * beside the plan, then the plan file becomes the result. Feedback (`--feedback`) supplies the locks
 * and answered questions that function enforces; turning comments into ops is `plan --revise`'s.
 */

import { stat } from 'node:fs/promises'
import { basename, resolve } from 'node:path'

import { CliError, formatSchemaIssues } from './cli-error'
import { toPosixRelative } from './discovery'
import { readPlanFile } from './plan-render'
import { describeUnapproved, PLAN_APPROVAL_GATED_COMMANDS, readPlanApprovalStanding } from './plan/approvals'
import { writeFileAtomic } from './plan/beside'
import { readPlanDecisions } from './plan/decisions'
import { FEEDBACK_STDIN, readJsonWithinLimit, readPlanFeedback } from './plan/feedback'
import { canonicalJson, planDigest } from './plan/identity'
import { readPlanRevisionRecords, writePlanRevisionRecord } from './plan/revision-records'
import { createPlanRevision, diffPlans, type PlanReopenedElement, type PlanRevisionRejection, type PlanRevisionOp } from './plan/revision'
import { hasBaseline, planBaseline, PlanDraftSchema, planSchemaFor, type Plan, type PlanDraft } from './plan/schema'

export const PLAN_REVISE_REPORT_VERSION = 1

/** What `--json` prints. */
export interface PlanReviseReport {
  reportVersion: typeof PLAN_REVISE_REPORT_VERSION
  /** `hash` is the result's; for a draft it is `planDigest()`, which names the draft's records and no approval. */
  plan: { file: string; title: string; hash: string; draft: boolean }
  parent: string
  /** The revision record, relative to the application root, POSIX separators. */
  revisionFile: string
  ops: number
  /** Elements the feedback approved that an op changed with `reopens`. */
  reopened: PlanReopenedElement[]
  /** Questions the feedback answered, which the revision removed. */
  answered: string[]
  /** The plan has a baseline, so the new hash needs `plan:approve` before the gated commands accept it. */
  approvalNeeded: boolean
  /** Elements the decision log waived at the parent hash: a waiver names its hash, so the result inherits none. */
  waiversLeft: string[]
  decisionsUnreadable?: string
}

export interface PlanReviseFileOptions {
  /** A `{ "ops": [...] }` document, the shape a revising producer emits; `-` reads standard input. */
  ops?: string
  /** A full copy of the plan with the change made in it; `-` reads standard input. */
  edited?: string
  feedback?: string
  /** Every op derived from `edited` carries it as its `reason`. Required with `edited`. */
  message?: string
  /** Put on every op derived from `edited`; it only counts where the feedback approved the element. */
  reopens?: string
  /** What `revisionFile` is reported relative to. Defaults to `cwd`. */
  app?: string
  cwd?: string
  /** Test seam: where `-` reads from. */
  stdin?: () => AsyncIterable<Uint8Array>
}

const DOCUMENT_FLAGS = ['ops', 'edited', 'feedback'] as const

export type PlanReviseDocumentFlags = Partial<Record<(typeof DOCUMENT_FLAGS)[number], string>>

/**
 * citty parses `--ops -` as `--ops ''` and drops the `-`, so the dash is read back off the raw
 * arguments: the last spelling of the flag decides, as the parsed value does. `--ops=-` parses.
 */
export function withStdinDashes(args: PlanReviseDocumentFlags, rawArgs: readonly string[]): PlanReviseDocumentFlags {
  const recovered = { ...args }
  for (const flag of DOCUMENT_FLAGS) {
    if (recovered[flag] !== '') continue
    const spellings = rawArgs.map((token, index) => (token === `--${flag}` || token.startsWith(`--${flag}=`) ? index : -1))
    const at = Math.max(...spellings)
    if (rawArgs[at] === `--${flag}` && rawArgs[at + 1] === FEEDBACK_STDIN) recovered[flag] = FEEDBACK_STDIN
  }
  return recovered
}

function refuseInputs(options: PlanReviseFileOptions): void {
  for (const flag of DOCUMENT_FLAGS) {
    if (options[flag] === '') throw new CliError(`--${flag} needs a file, or - for standard input.`)
  }
  if (options.ops === undefined && options.edited === undefined) {
    throw new CliError(
      `Pass the change as --ops <file> (a { "ops": [...] } document) or --edited <file> (a copy of the plan with the change made in it). ${
        options.feedback === undefined ? '' : 'Feedback alone changes nothing: plan:revise applies its approvals and answers to a change, and does not turn its comments into one.'
      }`.trim(),
    )
  }
  if (options.ops !== undefined && options.edited !== undefined) throw new CliError('Pass --ops or --edited, not both: a revision has one change.')
  const fromStdin = [options.ops, options.edited, options.feedback].filter((source) => source === FEEDBACK_STDIN)
  if (fromStdin.length > 1) throw new CliError('Only one of --ops, --edited and --feedback can read standard input (-); pass the others as files.')
  if (options.ops !== undefined && (options.message !== undefined || options.reopens !== undefined)) {
    throw new CliError('--message and --reopens apply to --edited. Each op in an --ops document carries its own reason and reopens.')
  }
  if (options.edited !== undefined && (options.message === undefined || options.message.trim() === '')) {
    throw new CliError('--edited needs --message: it is the reason every derived op records.')
  }
}

/**
 * The parent is the plan file as it stands, never a copy read from git. It is accepted as a draft
 * nobody approved, at an approved hash, or at the `result` a revision beside it records, so a plan
 * can be revised again before it is approved. This catches an edit made in place, not a forger:
 * the records are committed files anyone can write.
 */
async function requireRevisableParent(path: string, plan: PlanDraft | Plan): Promise<void> {
  const standing = await readPlanApprovalStanding(path, plan)
  if (standing === undefined || standing.state === 'approved') return
  if (standing.state !== 'unapproved') throw new CliError(describeUnapproved(path, standing, 'it is not revised'))

  const read = await readPlanRevisionRecords(path)
  if (read.records.some((record) => record.revision.result === standing.hash)) return
  if (read.unreadable.length > 0) {
    throw new CliError(
      `${read.unreadable.join('\n')}\n${path} is not approved at its current hash ${standing.hash}, and a revision record that may name it will not read, so it is not revised. Fix the record, then run this again.`,
    )
  }
  throw new CliError(
    `${path} is not approved at its current hash ${standing.hash}, and no revision beside it names that hash: it was edited in place after approval, and the parent of a revision is a plan somebody approved or revised. Restore the approved plan (git checkout -- ${path}), keep the edit in a copy, and pass that copy as --edited <copy>.`,
  )
}

/** Any stat failure answers no: the read that follows reports it as a CliError, where `plan-render.ts`'s copy would throw it raw. */
async function isSameFile(a: string, b: string): Promise<boolean> {
  try {
    const [left, right] = await Promise.all([stat(a), stat(b)])
    return left.dev === right.dev && left.ino === right.ino
  } catch {
    return false
  }
}

async function readEditedPlan(
  parentPath: string,
  parent: PlanDraft | Plan,
  source: string,
  cwd: string,
  stdin: PlanReviseFileOptions['stdin'],
): Promise<{ child: PlanDraft | Plan; raw: string }> {
  if (source !== FEEDBACK_STDIN && (await isSameFile(resolve(cwd, source), parentPath))) {
    throw new CliError(
      `--edited names ${parentPath} itself, which is the parent. Keep the edit in a copy, restore the plan (git checkout -- ${parentPath} if it was committed), and pass the copy as --edited.`,
    )
  }
  const { document, raw, origin } = await readJsonWithinLimit(source, { what: 'edited plan', cwd, stdin })
  const parsed = planSchemaFor(document).safeParse(document)
  if (!parsed.success) throw new CliError(`The edited plan on ${origin} does not match the plan schema:\n${formatSchemaIssues(parsed.error)}`)
  if (canonicalJson(planBaseline(parsed.data)) !== canonicalJson(planBaseline(parent))) {
    throw new CliError(
      `The edited plan on ${origin} has ${hasBaseline(parsed.data) ? 'a different baseline' : 'no baseline'} from ${parentPath}${hasBaseline(parent) ? '' : ', which is a draft'}. A revision carries the baseline over unchanged; copy the plan with its baseline as it stands and edit the copy.`,
    )
  }
  return { child: parsed.data, raw }
}

function describeRejections(rejections: PlanRevisionRejection[], edited: boolean): string {
  const lines = rejections.map((rejection) => `  ${rejection.message}`)
  const locked = [...new Set(rejections.filter((rejection) => rejection.kind === 'locked').map((rejection) => rejection.id))]
  if (locked.length > 0) {
    lines.push(
      edited
        ? `The feedback approved ${locked.join(', ')}. Say why they change with --reopens "<reason>" (every derived op carries it, and it counts only where an element was approved), or pass the ops with --ops to give each its own reopens.`
        : `The feedback approved ${locked.join(', ')}. Give each op on them a reopens reason.`,
    )
  }
  const kept = rejections.filter((rejection) => rejection.kind === 'answered-question-kept').map((rejection) => rejection.id)
  if (kept.length > 0) {
    lines.push(`Apply the answer to ${kept.join(', ')} to what it affects and remove the question${edited ? ' from the edited plan' : ' with a remove op'}.`)
  }
  if (rejections.some((rejection) => rejection.kind === 'feedback-mismatch')) {
    lines.push('Export the feedback again from the page plan:render writes for the plan as it stands.')
  }
  return lines.join('\n')
}

/** The result in the author's key order, leaving out a section the parent omitted and the result holds at its default. */
function revisedDocument(parentDocument: unknown, result: PlanDraft | Plan): Record<string, unknown> {
  const authored = typeof parentDocument === 'object' && parentDocument !== null ? (parentDocument as Record<string, unknown>) : {}
  const values = result as Record<string, unknown>
  const shape = PlanDraftSchema.shape as Record<string, { safeParse: (value: unknown) => { success: boolean; data?: unknown } }>
  const keys = [...Object.keys(authored).filter((key) => key in values), ...Object.keys(values).filter((key) => !(key in authored))]
  return Object.fromEntries(
    keys.flatMap((key) => {
      if (!(key in authored) && key in shape) {
        const fallback = shape[key]!.safeParse(undefined)
        if (fallback.success && canonicalJson(fallback.data) === canonicalJson(values[key])) return []
      }
      return [[key, values[key]]]
    }),
  )
}

export async function planReviseFile(planPath: string, options: PlanReviseFileOptions): Promise<PlanReviseReport> {
  refuseInputs(options)
  const cwd = options.cwd ?? process.cwd()
  const { path, plan, document } = await readPlanFile(planPath, cwd)
  const root = resolve(options.app ?? cwd)
  await requireRevisableParent(path, plan)
  const feedback = options.feedback === undefined ? undefined : await readPlanFeedback(options.feedback, { cwd, stdin: options.stdin })

  let edited: { child: PlanDraft | Plan; raw: string } | undefined
  let opsDocument: unknown
  if (options.ops !== undefined) {
    opsDocument = (await readJsonWithinLimit(options.ops, { what: 'ops', cwd, stdin: options.stdin })).document
  } else {
    edited = await readEditedPlan(path, plan, options.edited as string, cwd, options.stdin)
    let ops: PlanRevisionOp[]
    try {
      ops = diffPlans(plan, edited.child, { reason: options.message as string, ...(options.reopens === undefined ? {} : { reopens: options.reopens }) })
    } catch (error) {
      throw new CliError(`The edited plan cannot be expressed as ops on ${path}: ${(error as Error).message}`)
    }
    if (ops.length === 0) throw new CliError(`The edited plan is ${path} as it stands, so there is nothing to revise.`)
    opsDocument = { ops }
  }

  const created = createPlanRevision(plan, opsDocument, feedback ? { feedback } : {})
  if (!created.ok) {
    throw new CliError(`The revision of ${path} is refused, and nothing was written:\n${describeRejections(created.rejections, edited !== undefined)}`)
  }
  const { revision } = created
  // For a copy this is also where an edit no op expresses would show: writing it would miss the record, writing the result would drop the edit.
  const content = edited ? edited.raw : `${JSON.stringify(revisedDocument(document, created.plan), null, 2)}\n`
  const reread = planSchemaFor(plan).safeParse(JSON.parse(content))
  if (!reread.success || planDigest(reread.data) !== revision.result) {
    throw new Error(
      `plan:revise would write a plan that does not read back as ${revision.result}; nothing was written.${edited ? ' Pass the change as --ops instead.' : ''}`,
    )
  }

  // The record first: a plan written without one would sit at a hash nothing names, and the next revise would refuse it.
  const recordPath = await writePlanRevisionRecord(path, revision)
  try {
    await writeFileAtomic(path, content)
  } catch (error) {
    throw new CliError(
      `The revision was recorded in ${recordPath}, but ${path} could not be written (${(error as Error).message}), so the plan is still at ${revision.parent}. Leave the record, which names a result the plan never reached, and run the command again.`,
    )
  }

  const decisions = await readPlanDecisions(path)
  const waiversLeft = (decisions.decisions?.waivers ?? []).filter((waiver) => waiver.planHash === revision.parent).map((waiver) => waiver.elementId)
  return {
    reportVersion: PLAN_REVISE_REPORT_VERSION,
    plan: { file: basename(path), title: created.plan.title, hash: revision.result, draft: !hasBaseline(created.plan) },
    parent: revision.parent,
    revisionFile: toPosixRelative(root, recordPath),
    ops: revision.ops.length,
    reopened: created.reopened,
    answered: (feedback?.answers ?? []).map((answer) => answer.questionId),
    approvalNeeded: hasBaseline(created.plan),
    waiversLeft,
    ...(decisions.unreadable ? { decisionsUnreadable: decisions.unreadable } : {}),
  }
}

export function formatPlanRevise(report: PlanReviseReport, planArgument: string): string {
  const named = report.plan.draft ? 'draft digest' : 'hash'
  const lines = [
    `${report.plan.title} (${report.plan.file})`,
    '',
    `Revised ${named} ${report.parent} into ${report.plan.hash}: ${report.ops} op(s), recorded in ${report.revisionFile}.`,
  ]
  if (report.reopened.length > 0) {
    lines.push('Reopened, though the feedback approved them:', ...report.reopened.map((entry) => `  ${entry.id} (ops[${entry.op}]): ${entry.reason}`))
  }
  if (report.answered.length > 0) lines.push(`Answered and removed: ${report.answered.join(', ')}`)
  if (report.waiversLeft.length > 0) {
    lines.push(
      `Warning: the decision log waived ${report.waiversLeft.join(', ')} at the parent hash, and a waiver does not carry over to a revision. Waive them again with plan:waive once the revision is approved, or withdraw them with plan:waive --remove.`,
    )
  }
  if (report.decisionsUnreadable) lines.push(`Warning: the decision log could not be read, so its waivers were not compared: ${report.decisionsUnreadable}`)
  lines.push(
    '',
    report.approvalNeeded
      ? `Next: guren plan:approve ${planArgument}. No approval names the new hash yet, so ${PLAN_APPROVAL_GATED_COMMANDS.join(', ')} refuse the plan until then.`
      : `Next: guren plan:render ${planArgument} to review the revised draft, then guren plan:approve ${planArgument}.`,
  )
  return lines.join('\n')
}
