import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import type { CheckReport } from '../src/check-result'
import { PlanDraftSchema, type PlanDraft } from '../src/plan/schema'
import { planDigest, planSlug, PLAN_STATE_VERSION, readPlanState, writePlanStepRecord, type PlanStepRecord } from '../src/plan/state'
import { judgePlan, summarize, type PlanElementStatus, type PlanStatus } from '../src/plan/status'
import { derivePlanTasks, findPlanStep, planStepIds, type PlanTaskDerivation } from '../src/plan/tasks'
import { applyVerification, hashFiles, sha256 } from '../src/plan/verification'
import { acceptanceTestFiles, PlanVerifier, type PlanStepVerification, type PlanVerifierOptions } from '../src/plan/verify'
import type { CapturedExec, CapturedRun } from '../src/subprocess'
import { loadCommentsPlan, planAppState } from './plan-fixture'

const HTTP = 'task/entity/model.comment/http'
const DATA = 'task/entity/model.comment/data'
const PAGES = 'task/entity/model.comment/pages'
const TESTS = 'task/entity/model.comment/tests'
const IDS = ['AC-comments-1', 'AC-comments-2', 'AC-comments-3', 'AC-comments-4']

let ROOT: string
let plan: PlanDraft
let derivation: PlanTaskDerivation

const FILES: Record<string, string> = {
  'app/Models/Comment.ts': 'export class Comment {}\n',
  'app/Http/Controllers/CommentController.ts': 'export class CommentController {}\n',
  'db/schema.ts': 'export const comments = {}\n',
  'tests/comments.test.ts': "test('[AC-comments-1] a signed-in user can comment', () => {})\ntest('[AC-comments-2] x', () => {})\ntest('[AC-comments-3] x', () => {})\ntest('[AC-comments-4] x', () => {})\n",
  'tests/posts.test.ts': "test('[AC-posts-10] unrelated', () => {})\n",
}

beforeAll(async () => {
  ROOT = await mkdtemp(join(tmpdir(), 'guren-plan-verify-'))
  for (const [file, text] of Object.entries(FILES)) {
    await mkdir(dirname(join(ROOT, file)), { recursive: true })
    await writeFile(join(ROOT, file), text, 'utf8')
  }
  plan = PlanDraftSchema.parse(loadCommentsPlan())
  derivation = derivePlanTasks(plan)
})

afterAll(async () => {
  await rm(ROOT, { recursive: true, force: true })
})

type ElementOverride = Partial<Pick<PlanElementStatus, 'state' | 'files'>>

/** The file an element of the fixture would be found in, were it written. */
function filesFor(id: string): string[] {
  if (id.startsWith('column.')) return ['db/schema.ts']
  if (id.startsWith('model.')) return ['app/Models/Comment.ts']
  return ['app/Http/Controllers/CommentController.ts']
}

/**
 * The fixture as `judgePlan()` judges it against the fixture app, every element then
 * moved to the state its kind completes at, with files as if written, unless `overrides`
 * says otherwise. `completesAt` and `change` are the judge's own, not a second copy.
 */
function statusOf(overrides: Record<string, ElementOverride> = {}): PlanStatus {
  const judged = judgePlan(plan, planAppState())
  const elements = judged.elements.map(
    (element): PlanElementStatus => ({ ...element, state: element.completesAt, files: filesFor(element.id), notes: [], ...overrides[element.id] }),
  )
  return { elements, summary: summarize(elements) }
}

function junit(cases: Array<{ name: string; file?: string; inner?: string }>): string {
  const byFile = new Map<string, string[]>()
  for (const entry of cases) {
    const file = entry.file ?? 'tests/comments.test.ts'
    const list = byFile.get(file) ?? []
    list.push(`<testcase name="${entry.name}" file="${file}">${entry.inner ?? ''}</testcase>`)
    byFile.set(file, list)
  }
  const suites = [...byFile].map(([file, list]) => `<testsuite name="${file}" file="${file}">${list.join('')}</testsuite>`).join('')
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="bun test">${suites}</testsuites>`
}

const PASSING = junit(IDS.map((id) => ({ name: `[${id}] x` })))
const FAILING = junit(IDS.map((id) => ({ name: `[${id}] x`, inner: '<failure message="no"/>' })))

interface FakeExec {
  exec: CapturedExec
  calls: string[][]
}

/** Answers by the command's first words; a `bun test` writes `report` where the reporter was told to, `null` writing nothing. */
function fakeExec(answers: Record<string, Partial<CapturedRun>> = {}, report: string | null = PASSING): FakeExec {
  const calls: string[][] = []
  const exec: CapturedExec = async (command) => {
    calls.push(command)
    const key = command.slice(1).join(' ')
    const outfile = command.find((arg) => arg.startsWith('--reporter-outfile='))?.slice('--reporter-outfile='.length)
    if (outfile !== undefined && report !== null) await writeFile(outfile, report, 'utf8')
    const match = Object.entries(answers).find(([prefix]) => key.startsWith(prefix))
    return { exitCode: 0, stdout: '', stderr: '', ...match?.[1] }
  }
  return { exec, calls }
}

function checkReport(checks: CheckReport['checks']): CheckReport {
  return { cwd: ROOT, checks, passCount: 0, warnCount: 0, failCount: checks.length }
}

function verifier(status: PlanStatus, fake: FakeExec, overrides: Partial<PlanVerifierOptions> = {}): PlanVerifier {
  return new PlanVerifier(plan, derivation, {
    root: ROOT,
    planDigest: 'digest',
    status: async () => status,
    exec: fake.exec,
    timeoutMs: 1000,
    scripts: { codegen: 'guren codegen', typecheck: 'tsc --noEmit', 'db:migrate': 'guren db:migrate' },
    check: async () => checkReport([]),
    now: () => new Date('2026-09-21T00:00:00Z'),
    ...overrides,
  })
}

function commandsOf(step: PlanStepVerification): Record<string, string> {
  return Object.fromEntries(step.record.commands.map((command) => [command.command, command.status]))
}

function commandOf(step: PlanStepVerification, command: string): PlanStepRecord['commands'][number] {
  const found = step.record.commands.find((candidate) => candidate.command === command)
  if (!found) throw new Error(`no ${command} command in ${step.stepId}`)
  return found
}

describe('acceptanceTestFiles', () => {
  test('should pick the files whose source carries one of the ids, whole and literally', async () => {
    const files = [join(ROOT, 'tests/comments.test.ts'), join(ROOT, 'tests/posts.test.ts')]

    expect(await acceptanceTestFiles(ROOT, files, ['AC-comments-1'])).toEqual(['tests/comments.test.ts'])
    expect(await acceptanceTestFiles(ROOT, files, ['AC-posts-1'])).toEqual([])
    expect(await acceptanceTestFiles(ROOT, files, [])).toEqual([])
  })
})

describe('PlanVerifier', () => {
  test('should verify a step whose commands pass and whose elements are at their completion state', async () => {
    const fake = fakeExec()

    const step = await verifier(statusOf(), fake).verify(HTTP)

    expect(step.record.outcome).toBe('verified')
    expect(step.taskId).toBe('task/entity/model.comment')
    expect(commandsOf(step)).toEqual({ codegen: 'pass', check: 'pass', tests: 'pass' })
    expect(step.record.acceptance).toEqual(IDS.map((id) => ({ id, status: 'passing' })))
    expect(step.record.incomplete).toEqual([])
    expect(step.record.planDigest).toBe('digest')
    expect(step.record.ranAt).toBe('2026-09-21T00:00:00.000Z')
    const testCall = fake.calls.find((call) => call[1] === 'test')!
    expect(testCall.slice(2, 3)).toEqual(['tests/comments.test.ts'])
    expect(testCall).toContain('--reporter=junit')
    expect(testCall.some((arg) => arg.startsWith('--reporter-outfile='))).toBe(true)
  })

  test('should fingerprint the files that hold the elements and the tests by their bytes, keeping one it cannot read as null', async () => {
    const status = statusOf({ 'controller.comments': { files: ['app/Http/Controllers/CommentController.ts', 'app/Http/Controllers/Gone.ts'] } })

    const step = await verifier(status, fakeExec()).verify(HTTP)

    expect(step.record.fingerprint.files).toEqual({
      'app/Http/Controllers/CommentController.ts': sha256(FILES['app/Http/Controllers/CommentController.ts']!),
      'app/Http/Controllers/Gone.ts': null,
      'tests/comments.test.ts': sha256(FILES['tests/comments.test.ts']!),
    })
    expect(step.record.fingerprint.environment.runtime).toMatch(/^bun /)
  })

  test('should report a step incomplete when an element it owns is not at its completion state, or was never judged', async () => {
    const status = statusOf({ 'action.comments.destroy': { state: 'planned' }, 'route.comments.store': { state: 'present' } })
    status.elements = status.elements.filter((element) => element.id !== 'policy.comment')

    const step = await verifier(status, fakeExec()).verify(HTTP)

    expect(step.record.outcome).toBe('incomplete')
    expect(step.record.incomplete).toEqual(['action.comments.destroy: planned', 'route.comments.store: present', 'policy.comment: not judged by plan:status'])
  })

  test('should verify an unjudged element on its commands and behaviours alone', async () => {
    const step = await verifier(statusOf({ 'view.posts.show': { state: 'unjudged' } }), fakeExec()).verify(PAGES)

    expect(step.record.outcome).toBe('verified')
  })

  test('should block a command whose script the app lacks, and run the fallback where one exists', async () => {
    const fake = fakeExec()

    const step = await verifier(statusOf(), fake, { scripts: {} }).verify(DATA)

    expect(step.record.outcome).toBe('blocked')
    expect(commandsOf(step)).toEqual({ codegen: 'pass', 'db:migrate': 'blocked', typecheck: 'blocked' })
    expect(step.record.commands.map((command) => command.reason)).toEqual([undefined, 'no "db:migrate" script in package.json', 'no "typecheck" script in package.json'])
    expect(fake.calls.some((call) => call[2] === 'codegen' && call[1].endsWith('bin.ts'))).toBe(true)
  })

  test('should fail typecheck with the compiler errors as findings', async () => {
    const fake = fakeExec({ 'run typecheck': { exitCode: 2, stdout: 'app/Models/Comment.ts(3,1): error TS2322: no\nFound 1 error.\n' } })

    const step = await verifier(statusOf(), fake).verify(DATA)

    expect(step.record.outcome).toBe('failed')
    expect(commandOf(step, 'typecheck')).toMatchObject({ status: 'fail', label: 'bun run typecheck', reason: '`bun run typecheck` exited 2', findings: ['app/Models/Comment.ts(3,1): error TS2322: no'] })
  })

  test('should block, not fail, a command whose tool the shell cannot find', async () => {
    const byCode = fakeExec({ 'run typecheck': { exitCode: 127, stderr: 'sh: tsc: command not found\n' } })
    const byText = fakeExec({ 'run codegen': { exitCode: 1, stderr: 'zsh: command not found: guren\n' } })

    const typecheck = await verifier(statusOf(), byCode).verify(DATA)
    const codegen = await verifier(statusOf(), byText).verify(DATA)

    expect(commandOf(typecheck, 'typecheck')).toMatchObject({ status: 'blocked', reason: '`bun run typecheck` exited 127: a tool it needs is not installed' })
    expect(commandOf(codegen, 'codegen')).toMatchObject({ status: 'blocked', reason: '`bun run codegen` exited 1: a tool it needs is not installed' })
  })

  test('should block, not fail, a migration whose output says the database is unreachable', async () => {
    const unreachable = fakeExec({ 'run db:migrate': { exitCode: 1, stderr: 'error: connect ECONNREFUSED 127.0.0.1:54322\n' } })
    const broken = fakeExec({ 'run db:migrate': { exitCode: 1, stderr: 'error: relation "comments" already exists\n' } })

    const blocked = await verifier(statusOf(), unreachable).verify(DATA)
    const failed = await verifier(statusOf(), broken).verify(DATA)

    expect(commandsOf(blocked)['db:migrate']).toBe('blocked')
    expect(blocked.record.outcome).toBe('blocked')
    expect(commandsOf(failed)['db:migrate']).toBe('fail')
    expect(failed.record.outcome).toBe('failed')
  })

  test('should call a step failed when a command failed, whatever else was blocked', async () => {
    const fake = fakeExec({ 'run db:migrate': { exitCode: 1, stderr: 'ECONNREFUSED\n' }, 'run typecheck': { exitCode: 2, stdout: 'a.ts(1,1): error TS1\n' } })

    const step = await verifier(statusOf(), fake).verify(DATA)

    expect(commandsOf(step)).toEqual({ codegen: 'pass', 'db:migrate': 'blocked', typecheck: 'fail' })
    expect(step.record.outcome).toBe('failed')
  })

  test('should not run what reads the generated files once codegen did not pass', async () => {
    const fake = fakeExec({ 'run codegen': { exitCode: 1, stderr: 'error: pages/Bad.tsx has no default export\n' } })

    const step = await verifier(statusOf(), fake).verify(HTTP)

    expect(step.record.outcome).toBe('failed')
    expect(step.record.commands.map((command) => [command.command, command.status, command.reason])).toEqual([
      ['codegen', 'fail', '`bun run codegen` exited 1'],
      ['check', 'blocked', '`bun run codegen` did not pass, so this did not run'],
      ['tests', 'blocked', '`bun run codegen` did not pass, so this did not run'],
    ])
    expect(fake.calls.some((call) => call[1] === 'test')).toBe(false)
  })

  test('should block a command that timed out', async () => {
    const fake = fakeExec({ 'run typecheck': { exitCode: 1, timedOut: true } })

    const step = await verifier(statusOf(), fake).verify(DATA)

    expect(commandOf(step, 'typecheck')).toMatchObject({ status: 'blocked', reason: '`bun run typecheck` timed out after 1000 ms' })
  })

  test('should fail check on a gating finding and block it when the checker throws', async () => {
    const failing = checkReport([{ key: 'routes', title: 'Routes', status: 'fail', message: 'PostController.destroy is not defined' }])

    const failed = await verifier(statusOf(), fakeExec(), { check: async () => failing }).verify(HTTP)
    const blocked = await verifier(statusOf(), fakeExec(), { check: async () => { throw new Error('routes/web.ts threw') } }).verify(HTTP)

    expect(commandOf(failed, 'check')).toMatchObject({ status: 'fail', findings: [expect.stringContaining('PostController.destroy')] })
    expect(commandOf(blocked, 'check')).toMatchObject({ status: 'blocked', reason: 'could not run: routes/web.ts threw' })
  })

  test('should fail the tests command on a behaviour that is not passing, naming its cases', async () => {
    const report = junit([
      { name: '[AC-comments-1] x' },
      { name: '[AC-comments-2] x', inner: '<failure message="expected 302"/>' },
      { name: '[AC-comments-3] x', inner: '<skipped/>' },
    ])

    const step = await verifier(statusOf(), fakeExec({ test: { exitCode: 1 } }, report)).verify(HTTP)

    expect(step.record.outcome).toBe('failed')
    expect(commandOf(step, 'tests')).toMatchObject({
      status: 'fail',
      reason: 'a behaviour is not passing',
      findings: ['[AC-comments-2] is failing: failed "[AC-comments-2] x"', '[AC-comments-3] is failing: skipped "[AC-comments-3] x"', '[AC-comments-4] is pending'],
    })
    expect(step.record.acceptance).toEqual([
      { id: 'AC-comments-1', status: 'passing' },
      { id: 'AC-comments-2', status: 'failing' },
      { id: 'AC-comments-3', status: 'failing' },
      { id: 'AC-comments-4', status: 'pending' },
    ])
  })

  test('should fail the tests command when bun test exits non-zero with every behaviour passing', async () => {
    const step = await verifier(statusOf(), fakeExec({ test: { exitCode: 1, stderr: 'error: Cannot find module "./setup"\n' } })).verify(HTTP)

    expect(commandOf(step, 'tests')).toMatchObject({
      status: 'fail',
      reason: expect.stringContaining('exited 1 with every behaviour passing'),
      findings: ['error: Cannot find module "./setup"'],
    })
  })

  test('should fail the tests command when no test file carries the behaviours, and when the test files cannot be listed', async () => {
    const fake = fakeExec()

    const none = await verifier(statusOf(), fake, { testFiles: async () => [join(ROOT, 'tests/posts.test.ts')] }).verify(HTTP)
    const unlisted = await verifier(statusOf(), fake, { testFiles: async () => { throw new Error('EACCES') } }).verify(HTTP)

    expect(commandOf(none, 'tests')).toMatchObject({ status: 'fail', reason: 'no test file carries [AC-comments-1], [AC-comments-2], [AC-comments-3], [AC-comments-4] as a literal token' })
    expect(commandOf(unlisted, 'tests')).toMatchObject({ status: 'fail' })
    expect(fake.calls.some((call) => call[1] === 'test')).toBe(false)
    expect(none.record.acceptance.map((behaviour) => behaviour.status)).toEqual(['pending', 'pending', 'pending', 'pending'])
  })

  test('should fail the tests command on an id the plan does not declare, recording its behaviours as pending', async () => {
    const report = junit([...IDS.map((id) => ({ name: `[${id}] x` })), { name: '[AC-comments-9] a typo' }])

    const step = await verifier(statusOf(), fakeExec({}, report)).verify(HTTP)

    expect(commandOf(step, 'tests')).toMatchObject({
      status: 'fail',
      findings: ['[AC-comments-9] in tests/comments.test.ts ("[AC-comments-9] a typo") is not a behaviour of the plan'],
    })
    expect(step.record.acceptance.map((behaviour) => behaviour.status)).toEqual(['pending', 'pending', 'pending', 'pending'])
  })

  test('should block the tests command when no report was written', async () => {
    const step = await verifier(statusOf(), fakeExec({ test: { exitCode: 1, stderr: 'bun: command failed\n' } }, null)).verify(HTTP)

    expect(commandOf(step, 'tests')).toMatchObject({ status: 'blocked', reason: 'no junit report was written', findings: ['bun: command failed'] })
  })

  test('should verify the tests step only when every behaviour has a case and each case failed', async () => {
    const allFailed = await verifier(statusOf(), fakeExec({ test: { exitCode: 1 } }, FAILING)).verify(TESTS)
    const onePassed = await verifier(statusOf(), fakeExec({ test: { exitCode: 1 } }, junit([{ name: '[AC-comments-1] x' }, ...IDS.slice(1).map((id) => ({ name: `[${id}] x`, inner: '<failure/>' }))]))).verify(TESTS)
    const oneSkipped = await verifier(statusOf(), fakeExec({ test: { exitCode: 1 } }, junit([{ name: '[AC-comments-1] x', inner: '<skipped/>' }, ...IDS.slice(1).map((id) => ({ name: `[${id}] x`, inner: '<failure/>' }))]))).verify(TESTS)
    const oneMissing = await verifier(statusOf(), fakeExec({ test: { exitCode: 1 } }, junit(IDS.slice(1).map((id) => ({ name: `[${id}] x`, inner: '<failure/>' }))))).verify(TESTS)

    expect(allFailed.record.outcome).toBe('verified')
    expect(commandOf(allFailed, 'tests:fail').status).toBe('pass')
    expect(commandOf(onePassed, 'tests:fail')).toMatchObject({ status: 'fail', reason: 'a behaviour is not failing', findings: ['[AC-comments-1] must fail before its implementation exists: passed "[AC-comments-1] x"'] })
    expect(commandOf(oneSkipped, 'tests:fail')).toMatchObject({ status: 'fail', findings: ['[AC-comments-1] must fail before its implementation exists: skipped "[AC-comments-1] x"'] })
    expect(commandOf(oneMissing, 'tests:fail')).toMatchObject({ status: 'fail', findings: ['[AC-comments-1] has no test'] })
  })

  test('should run a command once per verifier and reuse the result across steps', async () => {
    const fake = fakeExec()
    const run = verifier(statusOf(), fake)

    await run.verify(DATA)
    await run.verify(PAGES)
    await run.verify(HTTP)
    await run.verify(TESTS)

    expect(fake.calls.filter((call) => call[2] === 'codegen')).toHaveLength(1)
    expect(fake.calls.filter((call) => call[2] === 'typecheck')).toHaveLength(1)
    expect(fake.calls.filter((call) => call[1] === 'test')).toHaveLength(1)
  })

  test('should refuse a step the plan does not derive', async () => {
    expect(planStepIds(derivation)).toEqual(['task/entity/model.comment/scaffold', TESTS, DATA, HTTP, PAGES])
    expect(findPlanStep(derivation, 'task/nope')).toBeUndefined()
    await expect(verifier(statusOf(), fakeExec()).verify('task/nope')).rejects.toThrow('no step task/nope is derived from this plan')
  })
})

function record(overrides: Partial<PlanStepRecord> = {}): PlanStepRecord {
  return {
    outcome: 'verified',
    planDigest: 'digest',
    ranAt: '2026-09-21T00:00:00.000Z',
    durationMs: 1,
    commands: [],
    acceptance: [],
    incomplete: [],
    fingerprint: { files: { 'db/schema.ts': sha256(FILES['db/schema.ts']!), 'app/Models/Comment.ts': sha256(FILES['app/Models/Comment.ts']!) }, environment: { runtime: 'bun 1.3.14', platform: 'darwin', arch: 'arm64', hostname: 'h' } },
    ...overrides,
  }
}

const DATA_FILES = ['db/schema.ts', 'app/Models/Comment.ts']

describe('applyVerification', () => {
  test('should lift the elements of a verified step while its fingerprint still matches', async () => {
    const hashes = await hashFiles(ROOT, DATA_FILES)

    const { status, staleSteps } = applyVerification(statusOf(), derivation, { [DATA]: record() }, 'digest', hashes)

    const states = Object.fromEntries(status.elements.map((element) => [element.id, element.state]))
    expect(states['column.comment.id']).toBe('verified')
    expect(states['model.comment']).toBe('verified')
    expect(states['model.post']).toBe('verified')
    expect(states['route.comments.store']).toBe('wired')
    expect(status.summary.states.verified).toBe(6)
    expect(staleSteps).toEqual([])
  })

  test('should mark the elements drifted, naming the file, once a fingerprinted file changes', async () => {
    const hashes = new Map([['db/schema.ts', sha256('export const comments = { body: 1 }\n')], ['app/Models/Comment.ts', sha256(FILES['app/Models/Comment.ts']!)]])

    const { status } = applyVerification(statusOf(), derivation, { [DATA]: record() }, 'digest', hashes)

    const column = status.elements.find((element) => element.id === 'column.comment.id')!
    expect(column.state).toBe('drifted')
    expect(column.notes).toEqual([`Verified 2026-09-21T00:00:00.000Z by ${DATA}; changed since: db/schema.ts.`])
  })

  test('should treat a file unreadable now, or unreadable when it was recorded, as a change', async () => {
    const hashes = await hashFiles(ROOT, [...DATA_FILES, 'db/missing.ts'])
    const withMissing = record({ fingerprint: { ...record().fingerprint, files: { ...record().fingerprint.files, 'db/missing.ts': 'abc' } } })
    const recordedNull = record({ fingerprint: { ...record().fingerprint, files: { ...record().fingerprint.files, 'db/schema.ts': null } } })

    const missing = applyVerification(statusOf(), derivation, { [DATA]: withMissing }, 'digest', hashes)
    const unread = applyVerification(statusOf(), derivation, { [DATA]: recordedNull }, 'digest', hashes)

    expect(missing.status.elements.find((element) => element.id === 'column.comment.id')!.state).toBe('drifted')
    expect(unread.status.elements.find((element) => element.id === 'column.comment.id')!.state).toBe('drifted')
  })

  test('should lift a drop and an unjudged element, which have no file to cover', async () => {
    const hashes = await hashFiles(ROOT, DATA_FILES)
    const status = statusOf({ 'column.comment.id': { files: [] }, 'column.comment.body': { state: 'unjudged', files: [] } })
    const dropped = status.elements.find((element) => element.id === 'column.comment.id')!
    dropped.change = 'drop'
    dropped.completesAt = 'present'

    const { status: lifted } = applyVerification(status, derivation, { [DATA]: record() }, 'digest', hashes)

    expect(lifted.elements.find((element) => element.id === 'column.comment.id')!.state).toBe('verified')
    expect(lifted.elements.find((element) => element.id === 'column.comment.body')!.state).toBe('verified')
  })

  test('should lift nothing of an element the fingerprint does not cover', async () => {
    const hashes = await hashFiles(ROOT, DATA_FILES)
    const noFiles = statusOf({ 'column.comment.id': { files: [] } })
    const elsewhere = statusOf({ 'column.comment.id': { files: ['modules/billing/db/schema.ts'] } })

    const unfingerprinted = applyVerification(noFiles, derivation, { [DATA]: record() }, 'digest', hashes)
    const moved = applyVerification(elsewhere, derivation, { [DATA]: record() }, 'digest', hashes)
    const empty = applyVerification(statusOf(), derivation, { [DATA]: record({ fingerprint: { ...record().fingerprint, files: {} } }) }, 'digest', hashes)

    const column = unfingerprinted.status.elements.find((element) => element.id === 'column.comment.id')!
    expect(column.state).toBe('present')
    expect(column.notes).toEqual([`Verified 2026-09-21T00:00:00.000Z by ${DATA}, and nothing of it was fingerprinted, so that result could not expire and is not counted.`])
    expect(unfingerprinted.status.elements.find((element) => element.id === 'model.comment')!.state).toBe('verified')
    const movedColumn = moved.status.elements.find((element) => element.id === 'column.comment.id')!
    expect(movedColumn.state).toBe('drifted')
    expect(movedColumn.notes).toEqual([`Verified 2026-09-21T00:00:00.000Z by ${DATA}; now in a file that run did not fingerprint: modules/billing/db/schema.ts.`])
    expect(empty.status.summary.states.verified).toBe(0)
  })

  test('should lift nothing from a record of another plan digest, and say which step', async () => {
    const hashes = await hashFiles(ROOT, DATA_FILES)

    const { status, staleSteps } = applyVerification(statusOf(), derivation, { [DATA]: record({ planDigest: 'older' }) }, 'digest', hashes)

    expect(status.elements.find((element) => element.id === 'column.comment.id')!.state).toBe('present')
    expect(staleSteps).toEqual([DATA])
  })

  test('should lift nothing from a record that did not verify, and leave an element the code has lost with a note', async () => {
    const hashes = await hashFiles(ROOT, DATA_FILES)

    const failed = applyVerification(statusOf(), derivation, { [DATA]: record({ outcome: 'failed' }) }, 'digest', hashes)
    const lost = applyVerification(statusOf({ 'column.comment.id': { state: 'planned' } }), derivation, { [DATA]: record() }, 'digest', hashes)

    expect(failed.status.summary.states.verified).toBe(0)
    const column = lost.status.elements.find((element) => element.id === 'column.comment.id')!
    expect(column.state).toBe('planned')
    expect(column.notes).toEqual([`Verified 2026-09-21T00:00:00.000Z by ${DATA}, and no longer at the state that completes it.`])
  })

  test('should not touch the status it was given', async () => {
    const status = statusOf()
    const before = JSON.stringify(status)

    applyVerification(status, derivation, { [DATA]: record() }, 'digest', await hashFiles(ROOT, DATA_FILES))

    expect(JSON.stringify(status)).toBe(before)
  })
})

describe('plan state', () => {
  test('should name the state file after the plan file, without its extensions', () => {
    expect(planSlug('/x/comments.plan.json')).toBe('comments')
    expect(planSlug('comments.json')).toBe('comments')
    expect(planSlug('docs/plans/comments/plan.json')).toBe('plan')
  })

  test('should digest a draft and a plan alike, from their canonical bytes', () => {
    expect(planDigest(plan)).toMatch(/^[0-9a-f]{64}$/)
    expect(planDigest(plan)).toBe(planDigest(PlanDraftSchema.parse(loadCommentsPlan())))
    expect(planDigest(plan)).not.toBe(planDigest(PlanDraftSchema.parse({ ...loadCommentsPlan(), title: 'Other' })))
  })

  test('should write one step at a time, keep the others, and ignore the file in git', async () => {
    const root = await mkdtemp(join(tmpdir(), 'guren-plan-state-'))
    try {
      const path = await writePlanStepRecord(root, 'comments', DATA, record())
      await writePlanStepRecord(root, 'comments', HTTP, record({ outcome: 'failed' }))
      await writePlanStepRecord(root, 'comments', DATA, record({ durationMs: 2 }))

      expect(path).toBe(join(root, '.guren/plans/comments.state.json'))
      expect(await readFile(join(root, '.guren/plans/.gitignore'), 'utf8')).toBe('*.state.json\n')
      const read = await readPlanState(root, 'comments')
      expect(read.state?.stateVersion).toBe(PLAN_STATE_VERSION)
      expect(Object.keys(read.state!.steps)).toEqual([DATA, HTTP])
      expect(read.state!.steps[DATA]!.durationMs).toBe(2)
      expect(read.state!.steps[HTTP]!.outcome).toBe('failed')
      expect(await readPlanState(root, 'other')).toEqual({ state: undefined })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('should report a state file that does not read, and replace it on the next write', async () => {
    const root = await mkdtemp(join(tmpdir(), 'guren-plan-state-'))
    try {
      await mkdir(join(root, '.guren/plans'), { recursive: true })
      await writeFile(join(root, '.guren/plans/comments.state.json'), '{"stateVersion": 2, "steps": {}}', 'utf8')
      expect((await readPlanState(root, 'comments')).unreadable).toContain('does not match the state schema')
      await writeFile(join(root, '.guren/plans/comments.state.json'), '{', 'utf8')
      expect((await readPlanState(root, 'comments')).unreadable).toContain('is not valid JSON')

      await writePlanStepRecord(root, 'comments', DATA, record())

      expect(Object.keys((await readPlanState(root, 'comments')).state!.steps)).toEqual([DATA])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
