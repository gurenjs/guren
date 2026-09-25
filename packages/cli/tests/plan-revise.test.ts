import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { runCommand } from 'citty'

import { builtinSubCommands } from '../src/commands'
import { planApproveFile } from '../src/plan-approve'
import { formatPlanRevise, planReviseFile, withStdinDashes, type PlanReviseFileOptions, type PlanReviseReport } from '../src/plan-revise'
import { planWaiveFile } from '../src/plan-waive'
import { loadPlanAppState } from '../src/plan/app-state'
import { planApprovalsPath } from '../src/plan/approvals'
import { planRevisionsDir } from '../src/plan/beside'
import type { PlanFeedback } from '../src/plan/feedback'
import { planDigest, planHash } from '../src/plan/identity'
import { readPlanRevisionRecords } from '../src/plan/revision-records'
import { applyRevision, PlanHeadSchema } from '../src/plan/revision'
import { PlanDraftSchema, PlanSchema, type PlanDraft } from '../src/plan/schema'
import type { CapturedExec } from '../src/subprocess'
import { createTempRoot, writeWorkspaceFiles } from './helpers'
import { approvePlanFile, loadApprovedCommentsPlan, loadCommentsPlan, PLAN_APP_FILES, TEST_BASELINE } from './plan-fixture'

let ROOT: string

beforeAll(async () => {
  ROOT = await createTempRoot('guren-plan-revise-')
})

afterAll(async () => {
  await rm(ROOT, { recursive: true, force: true })
})

type Json = Record<string, unknown>

const ADD_DELETED_AT = {
  op: 'add',
  section: 'columns',
  parent: 'model.comment',
  element: { id: 'column.comment.deletedAt', name: 'deletedAt', change: { kind: 'add' }, type: 'datetime', nullable: true, unique: false, index: false },
  reason: 'soft delete',
}

/** A document with `edit` applied to a copy, as a person edits a copy of the plan. */
function edited(document: Json, edit: (copy: Json) => void): Json {
  const copy = structuredClone(document)
  edit(copy)
  return copy
}

function columnsOf(document: Json, model: string): Json[] {
  return ((document.models as Json[]).find((entry) => entry.id === model) as Json).columns as Json[]
}

function retypeBody(copy: Json): void {
  const body = columnsOf(copy, 'model.comment').find((column) => column.id === 'column.comment.body') as Json
  body.type = 'string'
}

async function writeJson(name: string, document: unknown): Promise<string> {
  const path = join(ROOT, name)
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, typeof document === 'string' ? document : `${JSON.stringify(document, null, 2)}\n`, 'utf8')
  return path
}

async function readJson(path: string): Promise<Json> {
  return JSON.parse(await readFile(path, 'utf8')) as Json
}

/** An approved plan and the files of a change beside it, in a directory of its own. */
async function approvedPlan(dir: string): Promise<string> {
  const plan = await writeJson(`${dir}/comments.plan.json`, loadApprovedCommentsPlan())
  await approvePlanFile(plan)
  return plan
}

function revise(plan: string, options: Partial<PlanReviseFileOptions>): Promise<PlanReviseReport> {
  return planReviseFile(plan, { app: ROOT, ...options })
}

function stdinOf(text: string): () => AsyncIterable<Uint8Array> {
  return async function* () {
    yield new TextEncoder().encode(text)
  }
}

describe('plan:revise', () => {
  test('should revise a draft from ops, record { parent, ops, result } and leave the plan at that result', async () => {
    const draft = loadCommentsPlan()
    const plan = await writeJson('draft/comments.plan.json', draft)
    const ops = await writeJson('draft/ops.json', { ops: [ADD_DELETED_AT] })

    const report = await revise(plan, { ops })

    const written = await readJson(plan)
    const parent = PlanDraftSchema.parse(draft)
    const [record] = (await readPlanRevisionRecords(plan)).records
    expect(report).toMatchObject({ plan: { draft: true }, parent: planDigest(parent), ops: 1, approvalNeeded: false, revisionFile: 'draft/comments.revisions/0001.json' })
    expect(record!.revision).toEqual({ parent: planDigest(parent), ops: [expect.objectContaining({ op: 'add' })], result: report.plan.hash })
    expect(planDigest(PlanDraftSchema.parse(written))).toBe(report.plan.hash)
    expect('baseline' in written).toBe(false)
    expect(applyRevision(parent, record!.revision)).toMatchObject({ ok: true, hash: report.plan.hash })
    // The author omitted these sections; the result holds them empty, so they stay omitted.
    expect(Object.keys(written)).toEqual(Object.keys(draft))
    expect(formatPlanRevise(report, 'comments.plan.json')).toContain('Next: guren plan:render comments.plan.json')
  })

  test('should write an edited copy as its author wrote it, at the recorded result, with the baseline carried over', async () => {
    const plan = await approvedPlan('edited')
    const before = await readJson(plan)
    const copyText = `${JSON.stringify(edited(before, retypeBody), null, 4)}\n`
    const copy = await writeJson('edited/copy.json', copyText)

    const report = await revise(plan, { edited: copy, message: 'comments are short' })

    const written = await readFile(plan, 'utf8')
    const [record] = (await readPlanRevisionRecords(plan)).records
    expect(written).toBe(copyText)
    expect(planHash(PlanSchema.parse(JSON.parse(written)))).toBe(record!.revision.result)
    expect((JSON.parse(written) as Json).baseline).toEqual(TEST_BASELINE)
    expect(record!.revision.ops).toEqual([expect.objectContaining({ op: 'modify', id: 'column.comment.body', reason: 'comments are short' })])
    expect(report).toMatchObject({ plan: { draft: false }, approvalNeeded: true })
    expect(formatPlanRevise(report, 'comments.plan.json')).toContain('Next: guren plan:approve comments.plan.json')
  })

  test('should write an ops result that reads back at the recorded result, its baseline unchanged', async () => {
    const plan = await approvedPlan('ops-baseline')
    const ops = await writeJson('ops-baseline/ops.json', { ops: [ADD_DELETED_AT] })

    const report = await revise(plan, { ops })

    const written = await readJson(plan)
    expect(planHash(PlanSchema.parse(written))).toBe(report.plan.hash)
    expect(written.baseline).toEqual(TEST_BASELINE)
    expect(columnsOf(written, 'model.comment').map((column) => column.id)).toContain('column.comment.deletedAt')
  })

  test('should revise a revised plan again before approval, and number the records in order', async () => {
    const plan = await approvedPlan('chain')
    const first = await revise(plan, { ops: await writeJson('chain/first.json', { ops: [ADD_DELETED_AT] }) })
    const copy = await writeJson('chain/copy.json', edited(await readJson(plan), retypeBody))

    const second = await revise(plan, { edited: copy, message: 'comments are short' })

    const records = (await readPlanRevisionRecords(plan)).records
    expect(records.map((record) => record.path.split('/').pop())).toEqual(['0001.json', '0002.json'])
    expect(second.parent).toBe(first.plan.hash)
    expect(records[1]!.revision).toMatchObject({ parent: first.plan.hash, result: second.plan.hash })
  })

  test('should refuse a plan edited in place after approval, and name the remedy', async () => {
    const plan = await approvedPlan('in-place')
    await writeJson('in-place/comments.plan.json', edited(await readJson(plan), retypeBody))
    const ops = await writeJson('in-place/ops.json', { ops: [ADD_DELETED_AT] })

    await expect(revise(plan, { ops })).rejects.toThrow(/no revision beside it names that hash.*git checkout -- .*--edited <copy>/su)
    expect(await readdir(join(ROOT, 'in-place'))).not.toContain('comments.revisions')
  })

  test('should refuse a draft whose approvals remain beside it', async () => {
    const plan = await approvedPlan('baseline-removed')
    const document = await readJson(plan)
    delete document.baseline
    await writeJson('baseline-removed/comments.plan.json', document)

    await expect(revise(plan, { ops: await writeJson('baseline-removed/ops.json', { ops: [ADD_DELETED_AT] }) })).rejects.toThrow(/lost its baseline/u)
  })

  test('should refuse an edited copy with another baseline, the plan itself, or no change', async () => {
    const plan = await approvedPlan('edited-refusals')
    const before = await readJson(plan)
    const rebased = await writeJson('edited-refusals/rebased.json', { ...edited(before, retypeBody), baseline: { rev: 'other', contextHash: {} } })
    const same = await writeJson('edited-refusals/same.json', before)

    await expect(revise(plan, { edited: rebased, message: 'm' })).rejects.toThrow(/a different baseline.*carries the baseline over unchanged/su)
    await expect(revise(plan, { edited: plan, message: 'm' })).rejects.toThrow(/names .* itself, which is the parent/u)
    await expect(revise(plan, { edited: same, message: 'm' })).rejects.toThrow(/nothing to revise/u)
    expect(await readFile(plan, 'utf8')).toBe(`${JSON.stringify(before, null, 2)}\n`)
  })

  test('should refuse a missing or doubled change, two readers of standard input, and flags the form does not take', async () => {
    const plan = await approvedPlan('inputs')
    const ops = await writeJson('inputs/ops.json', { ops: [ADD_DELETED_AT] })

    await expect(revise(plan, {})).rejects.toThrow(/Pass the change as --ops/u)
    await expect(revise(plan, { feedback: ops })).rejects.toThrow(/does not turn its comments into one/u)
    await expect(revise(plan, { ops, edited: ops, message: 'm' })).rejects.toThrow(/not both/u)
    await expect(revise(plan, { ops: '-', feedback: '-' })).rejects.toThrow(/Only one of --ops, --edited and --feedback can read standard input/u)
    await expect(revise(plan, { ops, message: 'm' })).rejects.toThrow(/--message and --reopens apply to --edited/u)
    await expect(revise(plan, { edited: ops })).rejects.toThrow(/--edited needs --message/u)
  })

  test('should read a bare - back off the raw arguments, which citty parses as an empty value', async () => {
    expect(withStdinDashes({ ops: '', feedback: 'f.json' }, ['p.json', '--ops', '-', '--feedback', 'f.json'])).toEqual({ ops: '-', feedback: 'f.json' })
    expect(withStdinDashes({ ops: '' }, ['p.json', '--ops', 'a.json', '--ops', ''])).toEqual({ ops: '' })
    await expect(runCommand(builtinSubCommands['plan:revise'], { rawArgs: ['p.json', '--ops', '-', '--feedback', '-'] })).rejects.toThrow(/Only one of --ops, --edited and --feedback/u)
    await expect(revise(join(ROOT, 'p.json'), { ops: '' })).rejects.toThrow(/--ops needs a file, or - for standard input/u)
  })

  test('should read ops from standard input', async () => {
    const plan = await approvedPlan('stdin')

    const report = await revise(plan, { ops: '-', stdin: stdinOf(JSON.stringify({ ops: [ADD_DELETED_AT] })) })

    expect(report.ops).toBe(1)
  })

  describe('with feedback', () => {
    function approve(plan: Json, ...ids: string[]): PlanFeedback {
      return { planHash: planHash(PlanSchema.parse(plan)), answers: [], elements: ids.map((elementId) => ({ elementId, verdict: 'approve' as const, comment: '' })) }
    }

    test('should refuse an edit to an approved element until --reopens says why, then list it reopened', async () => {
      const plan = await approvedPlan('locked')
      const before = await readJson(plan)
      const copy = await writeJson('locked/copy.json', edited(before, retypeBody))
      const feedback = await writeJson('locked/feedback.json', approve(before, 'column.comment.body'))

      await expect(revise(plan, { edited: copy, message: 'short', feedback })).rejects.toThrow(/approved column\.comment\.body\. Say why they change with --reopens/u)
      expect(await readdir(join(ROOT, 'locked'))).not.toContain('comments.revisions')

      const report = await revise(plan, { edited: copy, message: 'short', feedback, reopens: 'the editor caps comments' })
      expect(report.reopened).toEqual([{ id: 'column.comment.body', op: 0, reason: 'the editor caps comments' }])
    })

    test('should require an answered question removed, and report it answered once it is', async () => {
      const plan = await approvedPlan('answered')
      const before = await readJson(plan)
      const feedback = await writeJson('answered/feedback.json', { ...approve(before), answers: [{ questionId: 'Q-delete', option: 'soft' }] })
      const kept = await writeJson('answered/kept.json', edited(before, retypeBody))
      const removed = await writeJson(
        'answered/removed.json',
        edited(before, (copy) => {
          copy.questions = []
        }),
      )

      await expect(revise(plan, { edited: kept, message: 'm', feedback })).rejects.toThrow(/remove the question from the edited plan/u)
      const report = await revise(plan, { edited: removed, message: 'soft delete', feedback })
      expect(report.answered).toEqual(['Q-delete'])
    })

    test('should match a draft\'s feedback, which carries no plan hash', async () => {
      const plan = await writeJson('draft-feedback/comments.plan.json', loadCommentsPlan())
      const copy = await writeJson('draft-feedback/copy.json', edited(loadCommentsPlan(), retypeBody))
      const feedback = await writeJson('draft-feedback/feedback.json', { answers: [], elements: [{ elementId: 'column.comment.body', verdict: 'approve', comment: '' }] })

      await expect(revise(plan, { edited: copy, message: 'short', feedback })).rejects.toThrow(/approved column\.comment\.body/u)
      expect((await revise(plan, { edited: copy, message: 'short', feedback, reopens: 'agreed on review' })).reopened).toHaveLength(1)
    })
  })

  test('should warn about waivers taken against the parent hash', async () => {
    const plan = await approvedPlan('waivers')
    const noAuthor: CapturedExec = async () => ({ exitCode: 1, stdout: '', stderr: '' })
    await planWaiveFile(plan, { elementIds: ['policy.comment'], reason: 'next plan', exec: noAuthor, app: ROOT })

    const report = await revise(plan, { ops: await writeJson('waivers/ops.json', { ops: [ADD_DELETED_AT] }) })

    expect(report.waiversLeft).toEqual(['policy.comment'])
    expect(formatPlanRevise(report, 'comments.plan.json')).toContain('does not carry over to a revision')
  })

  test('should number a record after every record name present', async () => {
    const plan = await approvedPlan('numbering')
    await writeJson('numbering/comments.revisions/0009.json', 'not json')

    const report = await revise(plan, { ops: await writeJson('numbering/ops.json', { ops: [ADD_DELETED_AT] }) })

    expect(report.revisionFile).toBe('numbering/comments.revisions/0010.json')
  })

  test('should keep revisions under revisions/ in the §9 layout', async () => {
    const plan = await writeJson('layout/docs/plans/comments/plan.json', loadApprovedCommentsPlan())
    await approvePlanFile(plan)

    await revise(plan, { ops: await writeJson('layout/ops.json', { ops: [ADD_DELETED_AT] }) })

    expect(await readdir(planRevisionsDir(plan))).toEqual(['0001.json'])
    expect(planRevisionsDir(plan)).toBe(join(ROOT, 'layout/docs/plans/comments/revisions'))
  })
})

describe('guren plan:revise, then plan:approve', () => {
  const log = spyOn(console, 'log').mockImplementation(() => {})
  afterEach(() => log.mockClear())
  afterAll(() => log.mockRestore())

  function git(dir: string, ...args: string[]): void {
    const result = Bun.spawnSync(['git', '-c', 'user.name=Approver', '-c', 'user.email=approver@example.com', ...args], { cwd: dir, stdout: 'pipe', stderr: 'pipe' })
    if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr.toString()}`)
  }

  test('should leave a revised draft that plan:approve stamps although the plan and its record are uncommitted', async () => {
    const app = join(ROOT, 'approve-after')
    const planFile = 'docs/plans/comments/plan.json'
    await writeWorkspaceFiles(app, { ...PLAN_APP_FILES, [planFile]: JSON.stringify({ ...loadCommentsPlan(), questions: [] }) })
    git(app, 'init', '-q')
    git(app, 'add', '-A')
    git(app, 'commit', '-q', '-m', 'init')
    const plan = join(app, planFile)
    const parsed: PlanDraft = PlanDraftSchema.parse(await readJson(plan))
    const head = PlanHeadSchema.parse(Object.fromEntries(Object.keys(PlanHeadSchema.shape).map((key) => [key, parsed[key as keyof PlanDraft]])))
    await writeWorkspaceFiles(app, { 'ops.json': JSON.stringify({ ops: [{ op: 'modify', section: 'plan', element: { ...head, summary: 'Comments, soft-deleted.' }, reason: 'soft delete' }] }) })
    git(app, 'add', 'ops.json')
    git(app, 'commit', '-q', '-m', 'ops')

    await runCommand(builtinSubCommands['plan:revise'], { rawArgs: [plan, '--ops', join(app, 'ops.json'), '--app', app] })
    const report = await planApproveFile(plan, { app: () => loadPlanAppState(app), appRoot: app })

    expect(report.stamped).toBeDefined()
    expect(JSON.parse(await readFile(planApprovalsPath(plan), 'utf8'))).toMatchObject({ approvals: [{ hash: report.plan.hash }] })
  })
})
