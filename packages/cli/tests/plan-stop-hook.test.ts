import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { planNextFile } from '../src/plan-next'
import { judgeStopHook, MAX_STEP_CONTINUATIONS, planStopHookFindings, recordSignature } from '../src/plan-stop-hook'
import { parsePlanDocument } from '../src/plan-render'
import { PLAN_STATUS_REPORT_VERSION } from '../src/plan-status'
import { planVerifyFile, type PlanVerifyReport } from '../src/plan-verify'
import { planWaiveFile } from '../src/plan-waive'
import { judgeFreshness, stampContextHash } from '../src/plan/freshness'
import { PlanSchema } from '../src/plan/schema'
import { judgeStepContext } from '../src/plan/step-context'
import { planDigest, PLAN_STATE_VERSION, type PlanActiveStep, type PlanState, type PlanStepRecord } from '../src/plan/state'
import { judgePlan, type PlanElementState, type PlanElementStatus } from '../src/plan/status'
import { derivePlanTasks, planStepIds } from '../src/plan/tasks'
import { sha256 } from '../src/plan/verification'
import { writeWorkspaceFiles } from './helpers'
import { approvedAgainst, approveIfStamped, approvePlanFile, loadApprovedCommentsPlan, loadCommentsPlan, planAppState } from './plan-fixture'

// The verification itself is faked here (`verify`); the shipped hooks run it for real in
// agent-hook-gate.test.ts. What this covers is the decision and what it writes to state.
const PLAN = parsePlanDocument(loadCommentsPlan())
const DIGEST = planDigest(PLAN)
const [SCAFFOLD, , DATA, HTTP] = planStepIds(derivePlanTasks(PLAN)) as [string, string, string, string]
const NOW = () => new Date('2026-09-21T10:00:00.000Z')
const ENVIRONMENT = { runtime: 'bun', platform: 'darwin', arch: 'arm64', hostname: 'h' }

let ROOT: string

function record(overrides: Partial<PlanStepRecord> = {}): PlanStepRecord {
  return {
    outcome: 'incomplete',
    planDigest: DIGEST,
    ranAt: '2026-09-21T09:00:00.000Z',
    durationMs: 3,
    commands: [
      { command: 'codegen', label: 'bun run codegen', status: 'pass', durationMs: 1, findings: [] },
      { command: 'check', label: 'guren check', status: 'pass', durationMs: 1, findings: [] },
    ],
    acceptance: [{ id: 'AC-comments-1', status: 'passing' }],
    incomplete: ['action.comments.destroy: planned'],
    waived: [],
    fingerprint: { files: { 'lib.ts': sha256('export const a = 1\n') }, environment: ENVIRONMENT },
    ...overrides,
  }
}

function active(overrides: Partial<PlanActiveStep> = {}): PlanActiveStep {
  return { plan: 'comments.plan.json', step: HTTP, startedAt: '2026-09-21T08:00:00.000Z', continuations: 0, ...overrides }
}

/** A verify report over the fixture app state, with the step's record as given and no blocked element unless asked. */
function report(stepId: string, stepRecord: PlanStepRecord, blocked: string[] = []): PlanVerifyReport {
  const status = judgePlan(PLAN, planAppState())
  const elements: PlanElementStatus<PlanElementState>[] = status.elements.map((element) => {
    if (blocked.includes(element.id)) return { ...element, state: 'blocked', reason: 'the reader failed' }
    if (element.state === 'blocked') return { ...element, state: 'planned', reason: undefined }
    return element
  })
  return {
    reportVersion: PLAN_STATUS_REPORT_VERSION,
    plan: { file: 'comments.plan.json', title: PLAN.title, hash: null },
    elements,
    summary: status.summary,
    verification: { stateFile: '.guren/plans/comments.state.json', staleSteps: [], decisionsFile: 'comments.decisions.json', staleWaivers: [] },
    steps: [{ stepId, taskId: 'task/entity/model.comment', record: stepRecord }],
    skipped: [],
  }
}

/** A plan with a baseline is approved at its hash unless `approve` is false, as `plan:approve` would leave it. */
async function createApp(name: string, state?: Partial<PlanState>, plan: unknown = loadCommentsPlan(), { approve = true } = {}): Promise<string> {
  const app = join(ROOT, name)
  await writeWorkspaceFiles(app, {
    // The client dependency keeps the app fullstack, so the scaffold steps are derived.
    'package.json': JSON.stringify({ name, type: 'module', dependencies: { '@guren/inertia-client': '*' } }),
    'lib.ts': 'export const a = 1\n',
    'comments.plan.json': JSON.stringify(plan),
    ...(state ? { '.guren/plans/comments.state.json': JSON.stringify({ stateVersion: PLAN_STATE_VERSION, steps: {}, ...state }) } : {}),
  })
  if (approve) await approveIfStamped(join(app, 'comments.plan.json'), plan)
  return app
}

async function readState(app: string): Promise<PlanState> {
  return JSON.parse(await readFile(join(app, '.guren/plans/comments.state.json'), 'utf8')) as PlanState
}

describe('judgeStopHook', () => {
  test('should let a verified step through and block an incomplete one with its signature', () => {
    expect(judgeStopHook(active(), record({ outcome: 'verified', incomplete: [] }), [], false)).toEqual({ kind: 'verified' })
    const incomplete = record()
    expect(judgeStopHook(active(), incomplete, [], false)).toEqual({ kind: 'continue', signature: recordSignature(incomplete) })
    expect(judgeStopHook(active({ continuations: MAX_STEP_CONTINUATIONS - 1 }), incomplete, [], true)).toMatchObject({ kind: 'continue' })
  })

  test('should give up on a blocked step, a blocked element, an unchanged record after a continuation, and the third continuation', () => {
    const blocked = record({ outcome: 'blocked', commands: [{ command: 'codegen', label: 'bun run codegen', status: 'blocked', durationMs: 1, reason: 'no codegen script', findings: [] }], incomplete: [] })
    expect(judgeStopHook(active(), blocked, [], false)).toMatchObject({ kind: 'stalled', reason: 'the step is blocked (codegen: no codegen script)' })
    expect(judgeStopHook(active(), record(), [{ id: 'validator.comment', reason: 'validators are named by exported symbol' }], false)).toMatchObject({ kind: 'stalled', reason: 'validator.comment is blocked (validators are named by exported symbol)' })
    const same = record()
    expect(judgeStopHook(active({ continuations: 1, lastSignature: recordSignature(same) }), same, [], true)).toMatchObject({ kind: 'stalled', reason: 'nothing about the step changed since the last continuation' })
    // The same record on a stop no hook blocked is a new turn, not a failed continuation.
    expect(judgeStopHook(active({ continuations: 1, lastSignature: recordSignature(same) }), same, [], false)).toMatchObject({ kind: 'continue' })
    expect(judgeStopHook(active({ continuations: MAX_STEP_CONTINUATIONS }), record(), [], true)).toMatchObject({ kind: 'stalled', reason: `${MAX_STEP_CONTINUATIONS} continuations on this step` })
  })

  test('should give up on stale context before anything else, and still let a verified step through', () => {
    const stale = [{ id: 'model.post', owned: false, through: ['route.comments.store'], within: [] }]
    expect(judgeStopHook(active(), record(), [], false, stale)).toMatchObject({
      kind: 'stalled',
      reason: 'what the step depends on changed since the plan was approved (model.post, named by route.comments.store)',
    })
    expect(judgeStopHook(active(), record({ outcome: 'verified', incomplete: [] }), [], false, stale)).toEqual({ kind: 'verified' })
  })

  test('should sign what a continuation could change and nothing else', () => {
    const base = record()
    expect(recordSignature(record({ ranAt: 'later', durationMs: 99, fingerprint: { ...base.fingerprint, environment: { ...ENVIRONMENT, hostname: 'elsewhere' } } }))).toBe(recordSignature(base))
    expect(recordSignature(record({ fingerprint: { ...base.fingerprint, files: { 'lib.ts': sha256('changed') } } }))).not.toBe(recordSignature(base))
    expect(recordSignature(record({ incomplete: [] }))).not.toBe(recordSignature(base))
    expect(recordSignature(record({ commands: [{ ...base.commands[0]!, status: 'fail' }] }))).not.toBe(recordSignature(base))
  })
})

describe('planStopHookFindings', () => {
  beforeAll(async () => {
    ROOT = await mkdtemp(join(tmpdir(), 'guren-plan-stop-hook-'))
  })

  afterAll(async () => {
    await rm(ROOT, { recursive: true, force: true })
  })

  test('should do nothing without a marked step, and not verify a stalled or a holding one', async () => {
    let verified = 0
    const verify = async (): Promise<PlanVerifyReport> => {
      verified += 1
      return report(HTTP, record())
    }
    expect(await planStopHookFindings(await createApp('none'), { stopHookActive: false }, { verify })).toEqual({ block: false })
    expect(await planStopHookFindings(await createApp('unmarked', {}), { stopHookActive: false }, { verify })).toEqual({ block: false })
    const stalled = await createApp('stalled', { active: active({ stalled: { at: 't', reason: 'r', output: 'o' } }) })
    expect(await planStopHookFindings(stalled, { stopHookActive: false }, { verify })).toEqual({ block: false })
    const holding = await createApp('holding', { steps: { [HTTP]: record({ outcome: 'verified', incomplete: [] }) }, active: active() })
    expect(await planStopHookFindings(holding, { stopHookActive: false }, { verify })).toEqual({ block: false })
    const empty = record({ outcome: 'verified', incomplete: [], fingerprint: { files: {}, environment: ENVIRONMENT } })
    const onCommands = await createApp('on-commands', { steps: { [SCAFFOLD]: empty }, active: active({ step: SCAFFOLD }) })
    expect(await planStopHookFindings(onCommands, { stopHookActive: false }, { verify })).toEqual({ block: false })
    expect(verified).toBe(0)
  })

  test('should block the stop while the step is incomplete and count the continuation', async () => {
    const app = await createApp('incomplete', { active: active() })
    const incomplete = record()

    const verdict = await planStopHookFindings(app, { stopHookActive: false }, { verify: async () => report(HTTP, incomplete), now: NOW })

    expect(verdict.block).toBe(true)
    expect(verdict.message).toBe(
      [
        `plan:verify on stop (comments.plan.json, ${HTTP}): the step is incomplete, so this turn is not done (continuation 1 of ${MAX_STEP_CONTINUATIONS}).`,
        `${HTTP}: incomplete (3 ms)`,
        '  pass     codegen     bun run codegen',
        '  pass     check       guren check',
        '  passing  [AC-comments-1]',
        '  not at its completion state: action.comments.destroy: planned',
        `Finish the step: it is done when \`bunx guren plan:verify comments.plan.json --step ${HTTP}\` reports it verified.`,
      ].join('\n'),
    )
    expect((await readState(app)).active).toEqual(active({ continuations: 1, lastSignature: recordSignature(incomplete) }))
  })

  test('should give up, say why, and record the stall with the last output', async () => {
    const same = record()
    const app = await createApp('giving-up', { active: active({ continuations: 1, lastSignature: recordSignature(same) }) })

    const verdict = await planStopHookFindings(app, { stopHookActive: true }, { verify: async () => report(HTTP, same), now: NOW })

    expect(verdict.block).toBe(false)
    expect(verdict.message).toContain(`plan:verify on stop (comments.plan.json, ${HTTP}): giving up, nothing about the step changed since the last continuation.\n${HTTP}: incomplete (3 ms)`)
    expect(verdict.message).toContain(
      'The step is recorded as stalled. Fix the environment, revise the plan, or waive an element with `bunx guren plan:waive comments.plan.json <element-id> --reason "<why>"`; `bunx guren plan:next comments.plan.json` then returns it again.',
    )
    const state = await readState(app)
    expect(state.active).toMatchObject({ continuations: 1, stalled: { at: '2026-09-21T10:00:00.000Z', reason: 'nothing about the step changed since the last continuation' } })
    expect(state.active!.stalled!.output).toContain('  not at its completion state: action.comments.destroy: planned')
    // Stalled, the next stop is not asked again.
    expect(await planStopHookFindings(app, { stopHookActive: true }, { verify: async () => report(HTTP, same) })).toEqual({ block: false })
  })

  test('should give up on a blocked element of the step, judged from the report', async () => {
    const app = await createApp('blocked-element', { active: active() })

    const verdict = await planStopHookFindings(app, { stopHookActive: false }, { verify: async () => report(HTTP, record(), ['validator.comment']) })

    expect(verdict.block).toBe(false)
    expect(verdict.message).toContain('giving up, validator.comment is blocked (the reader failed).')
    // An element of another step being blocked is not this step's stall.
    const other = await createApp('blocked-elsewhere', { active: active() })
    expect((await planStopHookFindings(other, { stopHookActive: false }, { verify: async () => report(HTTP, record(), ['model.comment']) })).block).toBe(true)
  })

  test('should hold a record resting on a waiver, and re-verify it once the waiver is gone', async () => {
    const approved = loadApprovedCommentsPlan()
    const resting = record({ outcome: 'verified', incomplete: [], waived: ['policy.comment'], planDigest: planDigest(parsePlanDocument(approved)) })
    const app = await createApp('waived', { steps: { [HTTP]: resting }, active: active() }, approved)
    const plan = join(app, 'comments.plan.json')
    await planWaiveFile(plan, { elementIds: ['policy.comment'], reason: 'the policy lands in the next plan', now: NOW })
    let verified = 0
    const verify = async (): Promise<PlanVerifyReport> => {
      verified += 1
      return report(HTTP, record())
    }

    expect(await planStopHookFindings(app, { stopHookActive: false }, { verify })).toEqual({ block: false })
    await planWaiveFile(plan, { elementIds: ['policy.comment'], remove: true })
    const withdrawn = await planStopHookFindings(app, { stopHookActive: false }, { verify })

    expect(verified).toBe(1)
    expect(withdrawn.block).toBe(true)
  })

  test('should say a decision log it could not read applied no waiver, beside the verdict', async () => {
    const app = await createApp('unreadable-log', { active: active() })
    await writeWorkspaceFiles(app, { 'comments.decisions.json': '{ "decisionsVersion": 2 }\n' })

    const verdict = await planStopHookFindings(app, { stopHookActive: false }, { verify: async () => report(HTTP, record()), now: NOW })

    expect(verdict.block).toBe(true)
    expect(verdict.message).toContain('does not match the decision log schema')
    expect(verdict.message).toContain('No waiver was applied, so the step is judged as if none were taken.')
    expect(verdict.message).toContain('so this turn is not done (continuation 1 of')
  })

  test('should say a log it could not read applied no waiver even where it verifies nothing', async () => {
    // The record stands, so the hook returns before it runs anything: the notice must still reach the session.
    const app = await createApp('unreadable-log-holding', { steps: { [HTTP]: record({ outcome: 'verified', incomplete: [] }) }, active: active() })
    await writeWorkspaceFiles(app, { 'comments.decisions.json': '{ "decisionsVersion": 2 }\n' })
    let verified = 0

    const verdict = await planStopHookFindings(app, { stopHookActive: false }, { verify: async () => { verified += 1; return report(HTTP, record()) } })

    expect(verified).toBe(0)
    expect(verdict.block).toBe(false)
    expect(verdict.message).toContain('No waiver was applied, so the step is judged as if none were taken.')
  })

  test('should let a verified step through silently', async () => {
    const app = await createApp('verified', { active: active({ continuations: 2 }) })

    expect(await planStopHookFindings(app, { stopHookActive: true }, { verify: async () => report(HTTP, record({ outcome: 'verified', incomplete: [] })) })).toEqual({ block: false })
    expect((await readState(app)).active).toEqual(active({ continuations: 2 }))
  })

  test('should let the stop through with the reason when the verification itself throws, and name an unreadable state file', async () => {
    const app = await createApp('throws', { active: active() })
    const verdict = await planStopHookFindings(app, { stopHookActive: false }, { verify: async () => { throw new TypeError('boom') } })
    expect(verdict).toEqual({ block: false, message: `plan:verify on stop (comments.plan.json, ${HTTP}): could not verify the step: TypeError: boom` })
    expect((await readState(app)).active).toEqual(active())

    await writeWorkspaceFiles(app, { '.guren/plans/comments.state.json': '{' })
    const unreadable = await planStopHookFindings(app, { stopHookActive: false })
    expect(unreadable.block).toBe(false)
    expect(unreadable.message).toMatch(/^plan:verify on stop: .*comments\.state\.json is not valid JSON/)
  })

  test('should clear, not block on, a mark in a state file other than the one its plan records to', async () => {
    const app = await createApp('orphan')
    await writeWorkspaceFiles(app, {
      'docs/plans/comments/plan.json': JSON.stringify(loadCommentsPlan()),
      '.guren/plans/plan.state.json': JSON.stringify({ stateVersion: PLAN_STATE_VERSION, steps: {}, active: active({ plan: 'docs/plans/comments/plan.json' }) }),
    })
    let verified = 0

    const verdict = await planStopHookFindings(app, { stopHookActive: false }, { verify: async () => { verified += 1; return report(HTTP, record()) } })

    expect(verified).toBe(0)
    expect(verdict.block).toBe(false)
    expect(verdict.message).toContain('the mark is in .guren/plans/plan.state.json, but this plan\'s records are kept in comments.state.json, so the mark was cleared')
    expect((JSON.parse(await readFile(join(app, '.guren/plans/plan.state.json'), 'utf8')) as PlanState).active).toBeUndefined()
  })

  test('should not block on a mark whose plan is gone or no longer derives the step', async () => {
    const gone = await createApp('gone', { active: active({ plan: 'missing.plan.json' }) })
    const verdict = await planStopHookFindings(gone, { stopHookActive: false })
    expect(verdict.block).toBe(false)
    expect(verdict.message).toMatch(/^plan:verify on stop \(missing\.plan\.json, .*\): Cannot read the plan at .*missing\.plan\.json/)
    expect(verdict.message).toContain('Run `bunx guren plan:next missing.plan.json` again once the plan is back.')

    const revised = await createApp('revised', { active: active({ step: 'task/entity/model.comment/nope' }) })
    const cleared = await planStopHookFindings(revised, { stopHookActive: false })
    expect(cleared).toEqual({ block: false, message: 'plan:verify on stop (comments.plan.json, task/entity/model.comment/nope): the plan no longer derives this step, so the mark was cleared. Run `bunx guren plan:next comments.plan.json` for the next one.' })
    expect((await readState(revised)).active).toBeUndefined()
  })

  test('should stop blocking once what the step names went stale, record it on the mark, and have plan:next report it', async () => {
    const approvedDocument = { ...loadCommentsPlan(), baseline: { rev: 'abc123', contextHash: stampContextHash(PLAN, planAppState()).contextHash } }
    const approved = PlanSchema.parse(approvedDocument)
    const moved = planAppState({ models: [{ name: 'Post', module: 'blog' }, 'User'] })
    // What plan:verify reports for the marked step: its stale context, its own elements left out.
    const withFreshness = (stepId: string): PlanVerifyReport => {
      const freshness = judgeFreshness(approved, moved)
      const context = judgeStepContext(approved, freshness, derivePlanTasks(approved), { inProgress: stepId }).get(stepId)
      return { ...report(stepId, record()), freshness, ...(context && context.stale.length > 0 ? { staleContext: [context] } : {}) }
    }
    const app = await createApp('stale', { active: active() }, approvedDocument)

    const verdict = await planStopHookFindings(app, { stopHookActive: false }, { verify: async () => withFreshness(HTTP), now: NOW })

    expect(verdict.block).toBe(false)
    expect(verdict.message).toContain('giving up, what the step depends on changed since the plan was approved (model.post, named by route.comments.store).')
    const stalled = (await readState(app)).active
    expect(stalled).toMatchObject({ step: HTTP, continuations: 0, stalled: { at: '2026-09-21T10:00:00.000Z', reason: expect.stringContaining('model.post') } })
    let verified = 0
    const counting = async (): Promise<PlanVerifyReport> => (verified++, withFreshness(HTTP))
    expect(await planStopHookFindings(app, { stopHookActive: true }, { verify: counting })).toEqual({ block: false })
    expect(verified).toBe(0)
    expect((await readState(app)).active).toEqual(stalled)

    const next = await planNextFile(join(app, 'comments.plan.json'), { appRoot: app, app: moved, now: NOW })
    expect(next.held.find((step) => step.id === HTTP)!.stalled).toMatchObject({ reason: expect.stringContaining('model.post') })
    expect(next.step!.id).toBe(SCAFFOLD)

    // What the marked step owns is its own work: the same staleness keeps the data step going.
    const data = await createApp('stale-own', { active: active({ step: DATA }) }, approvedDocument)
    expect((await planStopHookFindings(data, { stopHookActive: false }, { verify: async () => withFreshness(DATA), now: NOW })).block).toBe(true)
  })

  test('should give up on a plan whose hash no approval names without verifying, stay silent after, and verify again once approved', async () => {
    const document = approvedAgainst(loadCommentsPlan())
    // The steps before the marked one stand, so plan:next returns the marked step with its stall.
    const done = record({ outcome: 'verified', incomplete: [], planDigest: planDigest(parsePlanDocument(document)) })
    const before = Object.fromEntries(planStepIds(derivePlanTasks(PLAN)).slice(0, 3).map((id) => [id, done]))
    // A mark already continued, so the fresh mark plan:next gives the step is visible.
    const app = await createApp('unapproved', { steps: before, active: active({ continuations: 2, lastSignature: 'sig' }) }, document, { approve: false })
    let verified = 0
    const verify = async (): Promise<PlanVerifyReport> => (verified++, report(HTTP, record()))

    const verdict = await planStopHookFindings(app, { stopHookActive: false }, { verify, now: NOW })

    expect(verified).toBe(0)
    expect(verdict.block).toBe(false)
    expect(verdict.message).toContain(`plan:verify on stop (comments.plan.json, ${HTTP}): giving up, comments.plan.json is not approved at its current hash`)
    expect(verdict.message).toContain('Run guren plan:approve comments.plan.json')
    expect((await readState(app)).active).toMatchObject({ step: HTTP, stalled: { at: '2026-09-21T10:00:00.000Z', reason: expect.stringContaining('is not approved'), cause: 'approval' } })
    // The stall sticks, so the next stops neither block nor repeat the message.
    expect(await planStopHookFindings(app, { stopHookActive: true }, { verify })).toEqual({ block: false })
    expect(verified).toBe(0)

    await approvePlanFile(join(app, 'comments.plan.json'))
    const next = await planNextFile(join(app, 'comments.plan.json'), { appRoot: app, app: planAppState(), now: NOW })
    // Passing the gate answers the stall, so plan:next drops it rather than repeating advice already followed.
    expect(next.step!.id).toBe(HTTP)
    expect(next.step!.stalled).toBeUndefined()
    expect((await readState(app)).active).toEqual({ plan: 'comments.plan.json', step: HTTP, startedAt: '2026-09-21T10:00:00.000Z', continuations: 0 })
    const renewed = await planStopHookFindings(app, { stopHookActive: false }, { verify, now: NOW })
    expect(verified).toBe(1)
    expect(renewed.block).toBe(true)
  })

  test('should not verify a plan that changed after the hook judged its approval, in either direction', async () => {
    // The fake runs the real plan:verify after rewriting the plan, so its own reading is what is judged.
    // It stands in for the hook's verify, which calls planVerifyFile with no approval: `verify` takes
    // none and planVerifyFile has no option for one, so the types keep a stale reading from reaching it.
    const rewriting = (app: string, document: Record<string, unknown>) => async (planPath: string, appRoot: string, stepId: string): Promise<PlanVerifyReport> => {
      await writeWorkspaceFiles(app, { 'comments.plan.json': JSON.stringify(document) })
      return planVerifyFile(planPath, { app: planAppState(), appRoot, step: stepId })
    }
    const approved = approvedAgainst(loadCommentsPlan())

    const edited = await createApp('edited-mid-stop', { active: active() }, approved)
    const afterEdit = await planStopHookFindings(edited, { stopHookActive: false }, { verify: rewriting(edited, { ...approved, title: 'Comments, edited' }), now: NOW })
    expect(afterEdit.block).toBe(false)
    expect(afterEdit.message).toContain('could not verify the step: ')
    expect(afterEdit.message).toContain('is not approved at its current hash')

    const stamped = await createApp('stamped-mid-stop', { active: active() })
    const afterStamp = await planStopHookFindings(stamped, { stopHookActive: false }, { verify: rewriting(stamped, approved), now: NOW })
    expect(afterStamp.block).toBe(false)
    expect(afterStamp.message).toContain('is not approved at its current hash')
    // Neither run recorded anything for the step.
    expect((await readState(edited)).steps).toEqual({})
    expect((await readState(stamped)).steps).toEqual({})
  })

  test('should give up on a plan whose approvals file will not read, or whose baseline was deleted, with a log notice kept', async () => {
    const app = await createApp('unreadable-approvals', { active: active() }, approvedAgainst(loadCommentsPlan()), { approve: false })
    await writeWorkspaceFiles(app, { 'comments.approvals.json': '{', 'comments.decisions.json': '{ "decisionsVersion": 2 }\n' })
    let verified = 0
    const verify = async (): Promise<PlanVerifyReport> => (verified++, report(HTTP, record()))

    const verdict = await planStopHookFindings(app, { stopHookActive: false }, { verify, now: NOW })

    expect(verified).toBe(0)
    expect(verdict.block).toBe(false)
    expect(verdict.message).toContain('is not valid JSON')
    expect(verdict.message).toContain('so the step is not verified against it. Fix the approvals file')
    expect(verdict.message).toContain('No waiver was applied, so the step is judged as if none were taken.')

    // Deleting the baseline of an approved plan does not make it a draft nobody approved.
    const document = approvedAgainst(loadCommentsPlan())
    const removed = await createApp('baseline-removed', { active: active() }, document)
    const { baseline: _baseline, ...draft } = document
    await writeWorkspaceFiles(removed, { 'comments.plan.json': JSON.stringify(draft) })
    const lost = await planStopHookFindings(removed, { stopHookActive: false }, { verify, now: NOW })
    expect(verified).toBe(0)
    expect(lost.block).toBe(false)
    expect(lost.message).toContain('comments.plan.json has lost its baseline, but 1 approval(s) are recorded beside it')

    // A draft nobody approved is verified as before.
    const plain = await createApp('plain-draft', { active: active() })
    expect((await planStopHookFindings(plain, { stopHookActive: false }, { verify, now: NOW })).block).toBe(true)
    expect(verified).toBe(1)
  })

  test('should verify every marked plan under the root and join their messages', async () => {
    const app = await createApp('two', { active: active() })
    await writeWorkspaceFiles(app, {
      'other.plan.json': JSON.stringify({ ...loadCommentsPlan(), title: 'Other' }),
      '.guren/plans/other.state.json': JSON.stringify({ stateVersion: PLAN_STATE_VERSION, steps: {}, active: active({ plan: 'other.plan.json', step: SCAFFOLD }) }),
    })
    const seen: string[] = []
    const verify = async (_plan: string, _root: string, stepId: string): Promise<PlanVerifyReport> => {
      seen.push(stepId)
      return report(stepId, stepId === HTTP ? record({ outcome: 'verified', incomplete: [] }) : record({ outcome: 'failed', incomplete: [], commands: [{ command: 'typecheck', label: 'bun run typecheck', status: 'fail', durationMs: 1, findings: ['x.ts(1,1): error TS1'] }] }))
    }

    const verdict = await planStopHookFindings(app, { stopHookActive: false }, { verify })

    expect(seen.sort()).toEqual([HTTP, SCAFFOLD].sort())
    expect(verdict.block).toBe(true)
    expect(verdict.message).toContain(`plan:verify on stop (other.plan.json, ${SCAFFOLD}): the step is failed`)
    expect(verdict.message).not.toContain(`(comments.plan.json, ${HTTP})`)
  })
})
