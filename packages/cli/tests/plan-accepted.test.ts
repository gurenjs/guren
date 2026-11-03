import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { withoutBehaviourCheck } from '../src/plan-render'
import type { PlanAppDetail, PlanAppSideEffectDetail } from '../src/plan/app-detail'
import type { PlanAppState } from '../src/plan/app-state'
import {
  approvedAcceptance,
  planApprovalsPath,
  readPlanApprovals,
  readPlanApprovalStanding,
  recordPlanApproval,
  requireReadableApprovals,
  type PlanApprovalStanding,
} from '../src/plan/approvals'
import { renderPlanDoc } from '../src/plan/close-docs'
import { describeCloseBlockers } from '../src/plan/close-remedy'
import { planHash } from '../src/plan/identity'
import { groupElementsWithoutBehaviour, planElementsWithoutBehaviour } from '../src/plan/reach'
import { PlanDraftSchema, PlanSchema, type PlanDraft } from '../src/plan/schema'
import type { PlanStepRecord } from '../src/plan/state'
import { closesPlan, judgePlan, type PlanElementState, type PlanElementStatus } from '../src/plan/status'
import { derivePlanTasks, listPlanSteps } from '../src/plan/tasks'
import { applyVerification, applyWaivers } from '../src/plan/verification'
import { createTempRoot } from './helpers'
import { planAppState, TEST_BASELINE } from './plan-fixture'

const ADD = { kind: 'add' } as const
const JOB_FILE = 'app/Jobs/SendDigest.ts'
const DISPATCHER = 'app/Http/Controllers/DigestController.ts'
const JOB = { id: 'job.digest', change: ADD, kind: 'job', name: 'SendDigest', trigger: 'every morning', description: 'Sends the digest.' }

function column(id: string, name: string, change: Record<string, unknown>) {
  return { id, name, change, type: 'string', nullable: false, unique: false, index: false }
}

/** A plan of every kind `planElementsWithoutBehaviour()` decides on, and none a behaviour reaches. */
function document(sections: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    planVersion: 1,
    title: 'Digests',
    summary: 'Sends a digest of new posts.',
    locale: 'en',
    scope: { goals: [], nonGoals: [] },
    models: [
      {
        id: 'model.post',
        change: { kind: 'alter' },
        name: 'Post',
        table: 'posts',
        columns: [
          column('column.post.title', 'title', { kind: 'alter' }),
          column('column.post.slug', 'slug', ADD),
          column('column.post.summary', 'summary', { kind: 'rename', from: 'excerpt' }),
          column('column.post.id', 'id', { kind: 'existing' }),
        ],
        relationships: [],
        fillable: [],
      },
    ],
    sideEffects: [
      JOB,
      { id: 'mail.digest', change: { kind: 'alter' }, kind: 'mail', name: 'DigestMail', trigger: 'the job runs', description: 'The digest mail.' },
      { id: 'event.old', change: { kind: 'drop', reason: 'nothing listens' }, kind: 'event', name: 'OldEvent', trigger: 'never', description: 'Gone.' },
      { id: 'listener.log', change: { kind: 'existing' }, kind: 'listener', name: 'LogPost', trigger: 'a post', description: 'Kept.' },
      { id: 'job.renamed', change: { kind: 'rename', from: 'Prune' }, kind: 'job', name: 'Trim', trigger: 'nightly', description: 'Renamed.' },
    ],
    commands: [{ id: 'command.digest', command: 'guren make:job SendDigest', reason: 'the job class' }],
    ...sections,
  }
}

/** Only the added job, which is the element the overlay tests lift. */
function jobPlan(): PlanDraft {
  return PlanDraftSchema.parse(document({ models: [], sideEffects: [JOB], commands: [] }))
}

/** The step that verifies the job, as the derivation names it. */
function jobStep(plan: PlanDraft): string {
  return listPlanSteps(derivePlanTasks(plan)).find(({ step }) => step.elementIds.includes('job.digest'))!.step.id
}

const NO_SIDE_EFFECTS: PlanAppDetail['sideEffects'] = { job: [], event: [], listener: [], mail: [], notification: [] }

function job(usedIn: string[]): PlanAppSideEffectDetail {
  return { className: 'SendDigest', module: null, file: JOB_FILE, usedIn, unprovenIn: [], mentionedIn: [] }
}

function state(usedIn: string[] = [DISPATCHER]): PlanAppState {
  return planAppState({
    detail: {
      routes: [],
      mounts: { entry: 'mounted', modules: {}, files: { entry: [], descriptors: {} } },
      tables: [],
      models: [],
      unparsedModelFiles: [],
      actions: [],
      controllers: [],
      controllerCollisions: [],
      pages: [],
      validators: [],
      resources: [],
      resourcePayloads: [],
      policies: [],
      routeFiles: [],
      sideEffects: { ...NO_SIDE_EFFECTS, job: [job(usedIn)] },
    },
  })
}

function verifiedRecord(files: Record<string, string>): PlanStepRecord {
  return {
    outcome: 'verified',
    planDigest: 'digest',
    ranAt: 't',
    durationMs: 1,
    commands: [],
    acceptance: [],
    incomplete: [],
    waived: [],
    fingerprint: { files, environment: { runtime: 'bun', platform: 'darwin', arch: 'arm64', hostname: 'test' } },
  }
}

/** The job after every step is recorded as verified over `files`, read now as `now`. */
function liftJob(options: { accepted?: ReadonlySet<string>; usedIn?: string[]; now?: Record<string, string> } = {}): PlanElementStatus<PlanElementState> {
  const plan = jobPlan()
  const derivation = derivePlanTasks(plan)
  const recorded = { [JOB_FILE]: 'h', [DISPATCHER]: 'h' }
  const records = Object.fromEntries(listPlanSteps(derivation).map(({ step }) => [step.id, verifiedRecord(recorded)]))
  const hashes = new Map(Object.entries(options.now ?? recorded))
  const status = judgePlan(plan, state(options.usedIn))
  return applyVerification(status, derivation, records, 'digest', hashes, plan, options.accepted).status.elements.find((element) => element.id === 'job.digest')!
}

describe('planElementsWithoutBehaviour', () => {
  test('should list a command, an added or altered side effect and an altered column, in document order', () => {
    const plan = PlanDraftSchema.parse(document())

    expect(planElementsWithoutBehaviour(plan)).toEqual([
      { id: 'column.post.title', section: 'columns' },
      { id: 'job.digest', section: 'sideEffects' },
      { id: 'mail.digest', section: 'sideEffects' },
      { id: 'command.digest', section: 'commands' },
    ])
  })

  test('should leave out what its properties or its step lift: an added or renamed column, a dropped, existing or renamed side effect', () => {
    const ids = planElementsWithoutBehaviour(PlanDraftSchema.parse(document())).map((entry) => entry.id)

    for (const id of ['column.post.slug', 'column.post.summary', 'column.post.id', 'event.old', 'listener.log', 'job.renamed']) expect(ids).not.toContain(id)
  })

  test('should group the list by kind for the approval and the page', () => {
    expect(groupElementsWithoutBehaviour(planElementsWithoutBehaviour(PlanDraftSchema.parse(document())))).toEqual([
      'commands: command.digest',
      'side effects: job.digest, mail.digest',
      'altered columns: column.post.title',
    ])
  })
})

describe('applyVerification with an approval that accepted elements without a behaviour', () => {
  test('should lift an accepted side effect its verified step found wired to accepted, never to verified', () => {
    const element = liftJob({ accepted: new Set(['job.digest']) })

    expect(element.state).toBe('accepted')
    expect(element.hold).toBeUndefined()
    expect(element.notes.at(-1)).toBe(`Verified t by ${jobStep(jobPlan())}. No behaviour can reach it, and the approval accepted it as complete on that run.`)
  })

  test('should still hold an accepted side effect below its completion state, or whose file changed since its run', () => {
    expect(liftJob({ accepted: new Set(['job.digest']), usedIn: [] })).toMatchObject({ state: 'present', hold: { kind: 'incomplete' } })
    expect(liftJob({ accepted: new Set(['job.digest']), now: { [JOB_FILE]: 'changed', [DISPATCHER]: 'h' } })).toMatchObject({ state: 'drifted', hold: { kind: 'expired' } })
  })

  test('should hold one the approval did not accept, naming the re-approval, and keep the waiver alone where no approval stands', () => {
    const unaccepted = liftJob({ accepted: new Set() })
    expect(unaccepted).toMatchObject({ state: 'wired', hold: { kind: 'unreached' } })
    expect(unaccepted.hold?.note).toEndWith('the approval of this hash did not accept it as complete without one, so approve the plan again (plan:approve records that), or waive it.')

    expect(liftJob().hold?.note).toEndWith('no behaviour can reach it, so waive it.')
  })

  test('should keep an accepted element accepted under a waiver, which it does not need', () => {
    const accepted = liftJob({ accepted: new Set(['job.digest']) })
    const waived = applyWaivers({ elements: [accepted], summary: judgePlan(jobPlan(), state()).summary }, new Map([['job.digest', { elementId: 'job.digest', planHash: 'h', reason: 'r', at: 't' }]]))

    expect(waived.elements[0]!.state).toBe('accepted')
    expect(waived.elements[0]!.notes.at(-1)).toBe('Waived t: r. It is accepted, so the waiver is not needed.')
    expect(waived.summary.states.accepted).toBe(1)
  })
})

describe('closesPlan', () => {
  test('should let verified, accepted, waived and existing elements close a plan, and nothing else', () => {
    const element = (state: PlanElementState, change: 'add' | 'existing' = 'add') => ({ state, change })

    for (const state of ['verified', 'accepted', 'waived'] as const) expect(closesPlan(element(state))).toBe(true)
    for (const state of ['planned', 'present', 'wired', 'drifted', 'unjudged', 'blocked'] as const) expect(closesPlan(element(state))).toBe(false)
    expect(closesPlan(element('planned', 'existing'))).toBe(true)
  })
})

describe('describeCloseBlockers for an element no behaviour can reach', () => {
  const plan = jobPlan()
  const derivation = derivePlanTasks(plan)
  const wired = judgePlan(plan, state()).elements.find((element) => element.id === 'job.digest')!
  const waive = '`bunx guren plan:waive p.json job.digest --reason "<why>"`'
  const verify = `\`bunx guren plan:verify p.json --step ${jobStep(plan)}\``

  test('should send an accepted one to its step’s plan:verify run, since no behaviour is needed', () => {
    expect(describeCloseBlockers(plan, derivation, [wired], 'p.json', new Set(['job.digest']))[0]!.moves).toBe(`Run ${verify}; or waive it: ${waive}`)
  })

  test('should name the re-approval for one an approval did not accept, and only the waiver with no approval', () => {
    expect(describeCloseBlockers(plan, derivation, [wired], 'p.json', new Set())[0]!.moves).toBe(
      `No planned property of it matched beyond its existence and no behaviour can reach it, and the approval of this hash did not accept it as complete without one: approve the plan again with \`bunx guren plan:approve p.json\`, which records that, then run ${verify} if plan:status does not report it accepted; or waive it: ${waive}`,
    )
    expect(describeCloseBlockers(plan, derivation, [wired], 'p.json')[0]!.moves).toBe(
      `No planned property of it matched beyond its existence and no behaviour can reach it, so no plan:verify run lifts it: waive it with ${waive}`,
    )
  })
})

describe('the acceptance an approval records', () => {
  const ROOT_PREFIX = 'guren-plan-accepted-'
  let ROOT: string
  beforeAll(async () => {
    ROOT = await createTempRoot(ROOT_PREFIX)
  })
  afterAll(async () => {
    await rm(ROOT, { recursive: true, force: true })
  })

  const approved = (acceptedWithoutBehaviour?: string[]): PlanApprovalStanding => ({
    state: 'approved',
    hash: 'h',
    approval: { hash: 'h', approvedAt: 't', ...(acceptedWithoutBehaviour ? { acceptedWithoutBehaviour } : {}) },
  })

  test('should read the approval of the current hash only, none for an approval that recorded none, and nothing without one', () => {
    expect([...approvedAcceptance(approved(['job.digest']))!]).toEqual(['job.digest'])
    expect(approvedAcceptance(approved())?.size).toBe(0)
    expect(approvedAcceptance({ state: 'unapproved', hash: 'h' })).toBeUndefined()
    expect(approvedAcceptance(undefined)).toBeUndefined()
  })

  test('should inherit nothing from the approval of another hash: a revision accepts at its own approval', async () => {
    const plan = PlanSchema.parse({ ...document({ models: [] }), baseline: TEST_BASELINE })
    const path = join(ROOT, 'revision.plan.json')
    await writeFile(path, JSON.stringify(plan))
    const approvals = {
      approvalsVersion: 1,
      approvals: [
        { hash: 'parent', approvedAt: '2026-09-01T00:00:00.000Z', acceptedWithoutBehaviour: ['job.digest', 'command.digest'] },
        { hash: planHash(plan), approvedAt: '2026-09-02T00:00:00.000Z' },
      ],
    }
    await writeFile(planApprovalsPath(path), JSON.stringify(approvals))

    const standing = await readPlanApprovalStanding(path, plan)

    expect(standing?.state).toBe('approved')
    expect(approvedAcceptance(standing)?.size).toBe(0)
  })

  test('should add the acceptance to an entry approved before it was recorded, once', async () => {
    const path = join(ROOT, 'upgrade.plan.json')
    await writeFile(planApprovalsPath(path), JSON.stringify({ approvalsVersion: 1, approvals: [{ hash: 'h', approvedAt: 't', approvedBy: 'Ada' }] }))
    const approval = { hash: 'h', approvedAt: 'later', acceptedWithoutBehaviour: ['job.digest'] }

    const first = await recordPlanApproval(path, requireReadableApprovals(await readPlanApprovals(path)), approval)
    const bytes = await readFile(planApprovalsPath(path), 'utf8')
    const second = await recordPlanApproval(path, requireReadableApprovals(await readPlanApprovals(path)), approval)

    expect(first).toMatchObject({ acceptedAdded: ['job.digest'], existing: { approvedAt: 't', approvedBy: 'Ada', acceptedWithoutBehaviour: ['job.digest'] } })
    expect(second.acceptedAdded).toEqual([])
    expect(await readFile(planApprovalsPath(path), 'utf8')).toBe(bytes)
  })
})

describe('what plan:render and plan:close say of it', () => {
  test('should pin one advisory warning listing what approving accepts, and none for a plan with nothing of the kind', () => {
    expect(withoutBehaviourCheck(PlanDraftSchema.parse(document()))).toEqual({
      key: 'plan:without-behaviour',
      title: 'Completes without a behaviour',
      status: 'warn',
      advisory: true,
      message:
        "No behaviour can reach these 4 elements, so approving the plan accepts each as complete on its step's verified run, with no waiver at plan:close: commands: command.digest; side effects: job.digest, mail.digest; altered columns: column.post.title.",
      suggestion: "plan:approve records the acceptance for this plan hash only, and plan:status reports each one accepted once its step's run holds.",
    })
    expect(withoutBehaviourCheck(PlanDraftSchema.parse(document({ models: [], sideEffects: [], commands: [] })))).toBeUndefined()
  })

  test('should record the accepted elements under Decisions, beside the waivers or in their place', () => {
    const plan = PlanSchema.parse({ ...document({ models: [] }), baseline: TEST_BASELINE })
    const render = (waived: boolean) =>
      renderPlanDoc({
        plan,
        hash: 'h',
        slug: 'digests',
        approval: { hash: 'h', approvedAt: 't' },
        elements: [],
        waived: waived ? new Map([['mail.digest', { elementId: 'mail.digest', planHash: 'h', reason: 'next plan', at: 't' }]]) : new Map(),
        accepted: ['job.digest', 'command.digest'],
      })
    const accepted = "- Accepted at approval as complete on their step's verified run, since no behaviour can reach them: `job.digest`, `command.digest`"

    expect(render(false)).toContain(`## Decisions\n\nNo element was waived.\n\n${accepted}\n`)
    expect(render(true)).toContain(`## Decisions\n\n- Waived \`mail.digest\`: next plan (t)\n${accepted}\n`)
  })
})
