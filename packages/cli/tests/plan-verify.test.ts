import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import type { CheckReport } from '../src/check-result'
import { PlanDraftSchema, type PlanDraft } from '../src/plan/schema'
import { planDigest, planSlug, PLAN_STATE_GITIGNORE, PLAN_STATE_VERSION, readPlanState, writePlanStepRecord, type PlanStepRecord } from '../src/plan/state'
import { planHash } from '../src/plan/identity'
import { judgePlan, summarize, type PlanElementState, type PlanElementStatus, type PlanStatus } from '../src/plan/status'
import { derivePlanTasks, findPlanStep, planStepIds, type PlanTaskDerivation } from '../src/plan/tasks'
import { describeCloseBlockers } from '../src/plan/close-remedy'
import { behaviourReach } from '../src/plan/reach'
import { applyVerification, applyWaivers, hashFiles, overlayVerification, planWaivers, recordDrift, recordStillHolds, sha256 } from '../src/plan/verification'
import { PLAN_STATUS_REPORT_VERSION } from '../src/plan-status'
import { formatPlanVerify, type PlanVerifyReport } from '../src/plan-verify'
import { acceptanceTestFiles, PlanVerifier, type PlanStepVerification, type PlanVerifierOptions } from '../src/plan/verify'
import type { CapturedExec, CapturedRun } from '../src/subprocess'
import type { PlanWaiver } from '../src/plan/decisions'
import { loadCommentsPlan, loadParsedCommentsPlan, planAppState } from './plan-fixture'

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

type ElementOverride = Partial<Pick<PlanElementStatus, 'state' | 'files' | 'properties'>>

/** What a reader matched, so an element does not rest on its existence alone. */
const READ: PlanElementStatus['properties'] = [{ property: 'type', verdict: 'match', planned: 'text', actual: 'text' }]

/** The file an element of the fixture would be found in, were it written. */
function filesFor(id: string): string[] {
  if (id.startsWith('column.')) return ['db/schema.ts']
  if (id.startsWith('model.')) return ['app/Models/Comment.ts']
  return ['app/Http/Controllers/CommentController.ts']
}

/**
 * The fixture as `judgePlan()` judges it against the fixture app, every element then
 * moved to the state its kind completes at, with files and a matched property as if written, unless `overrides`
 * says otherwise. `completesAt` and `change` are the judge's own, not a second copy.
 */
function statusOf(overrides: Record<string, ElementOverride> = {}): PlanStatus {
  const judged = judgePlan(plan, planAppState())
  const elements = judged.elements.map(
    (element): PlanElementStatus => ({ ...element, state: element.completesAt, files: filesFor(element.id), properties: READ, notes: [], ...overrides[element.id] }),
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

/** What drizzle-kit prints when the migrations cover the schema; every fake answers a data step's check with it unless told otherwise. */
const NO_CHANGES = '{"status":"no_changes","dialect":"postgresql"}\n'

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
    const stdout = key.startsWith('drizzle-kit generate') ? NO_CHANGES : ''
    return { exitCode: 0, stdout, stderr: '', ...match?.[1] }
  }
  return { exec, calls }
}

function checkReport(checks: CheckReport['checks']): CheckReport {
  return { cwd: ROOT, checks, passCount: 0, warnCount: 0, failCount: checks.length }
}

function verifier(status: PlanStatus, fake: Pick<FakeExec, 'exec'>, overrides: Partial<PlanVerifierOptions> = {}): PlanVerifier {
  return new PlanVerifier(plan, derivation, {
    root: ROOT,
    planDigest: 'digest',
    status: async () => status,
    exec: fake.exec,
    timeoutMs: 1000,
    scripts: { codegen: 'guren codegen', typecheck: 'tsc --noEmit', 'db:migrate': 'guren db:migrate' },
    check: async () => checkReport([]),
    drizzleKit: async () => ({ bin: 'drizzle-kit', config: 'drizzle.config.ts' }),
    now: () => new Date('2026-09-21T00:00:00Z'),
    ...overrides,
  })
}

function elementOf(status: PlanStatus<PlanElementState>, id: string): PlanElementStatus<PlanElementState> {
  const found = status.elements.find((element) => element.id === id)
  if (!found) throw new Error(`no element ${id}`)
  return found
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

  test('should leave a waived element out of the judgement and record it, so the step verifies without it', async () => {
    const status = statusOf({ 'action.comments.destroy': { state: 'planned' }, 'policy.comment': { state: 'planned' } })
    const waived = new Set(['action.comments.destroy', 'policy.comment'])

    const step = await verifier(status, fakeExec(), { waived }).verify(HTTP)

    expect(step.record.outcome).toBe('verified')
    expect(step.record.incomplete).toEqual([])
    expect(step.record.waived).toEqual(['action.comments.destroy', 'policy.comment'])
    // A waived element is nothing the run watched, so its file is not what would expire the result.
    expect(Object.keys(step.record.fingerprint.files)).not.toContain('app/Policies/CommentPolicy.ts')
  })

  test('should waive an element plan:status never judged, since a person\u2019s decision does not wait on a reader', async () => {
    const status = statusOf()
    status.elements = status.elements.filter((element) => element.id !== 'policy.comment')

    const step = await verifier(status, fakeExec(), { waived: new Set(['policy.comment']) }).verify(HTTP)

    expect(step.record.outcome).toBe('verified')
    expect(step.record.waived).toEqual(['policy.comment'])
  })

  test('should ask for the status once, after the first codegen has run', async () => {
    const fake = fakeExec()
    const askedAfter: string[][] = []
    const run = verifier(statusOf(), fake, {
      status: async () => {
        askedAfter.push(...fake.calls)
        return statusOf()
      },
    })

    await run.verify(DATA)
    await run.verify(PAGES)

    expect(askedAfter.filter((call) => call[2] === 'codegen')).toHaveLength(1)
    expect(askedAfter.length).toBeGreaterThan(0)
    expect(askedAfter.length).toBe(new Set(askedAfter).size)
  })

  test('should run codegen before judging when no step ran one', async () => {
    const fake = fakeExec()
    let askedAfter: string[][] = []

    const status = await verifier(statusOf(), fake, {
      status: async () => {
        askedAfter = [...fake.calls]
        return statusOf()
      },
    }).status()

    expect(askedAfter.map((call) => call[2])).toEqual(['codegen'])
    expect(status.elements.length).toBeGreaterThan(0)
  })

  test('should record the tests command blocked, not throw, when the test spawn itself rejects', async () => {
    const fake = fakeExec()
    const rejecting: CapturedExec = async (command, cwd, options) => {
      if (command[1] === 'test') throw new Error('spawn bun ENOENT')
      return fake.exec(command, cwd, options)
    }

    const step = await verifier(statusOf(), { exec: rejecting }).verify(HTTP)

    expect(step.record.outcome).toBe('blocked')
    expect(commandOf(step, 'tests')).toMatchObject({ status: 'blocked', reason: 'could not run: spawn bun ENOENT' })
    expect(step.record.acceptance.map((behaviour) => behaviour.status)).toEqual(['pending', 'pending', 'pending', 'pending'])
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

  describe('recheckTests', () => {
    const titles = (ids: string[]): string => ids.map((id) => `test('[${id}] x', () => {})\n`).join('')

    test('should keep a drifted tests step verified while one file carries each id, and name a lost or doubled one', async () => {
      const root = await mkdtemp(join(tmpdir(), 'guren-plan-recheck-'))
      try {
        await mkdir(join(root, 'tests'), { recursive: true })
        await writeFile(join(root, 'tests/comments.test.ts'), titles(['AC-comments-1', 'AC-comments-3', 'AC-comments-4']), 'utf8')
        await writeFile(join(root, 'tests/more.test.ts'), titles(['AC-comments-3']), 'utf8')
        const previous = record({ acceptance: IDS.map((id) => ({ id, status: 'failing' as const })) })
        const recheck = (): Promise<PlanStepVerification> =>
          verifier(statusOf(), fakeExec(), { root, testFiles: async () => [join(root, 'tests/comments.test.ts'), join(root, 'tests/more.test.ts')] }).recheckTests(TESTS, previous)

        const step = await recheck()

        expect(step.record.outcome).toBe('failed')
        expect(step.record.commands[0]!.findings).toEqual(['[AC-comments-2] is carried by no test file', '[AC-comments-3] is carried by tests/comments.test.ts and tests/more.test.ts'])
        expect(step.record.acceptance).toEqual([
          { id: 'AC-comments-1', status: 'failing' },
          { id: 'AC-comments-2', status: 'pending' },
          { id: 'AC-comments-3', status: 'failing' },
          { id: 'AC-comments-4', status: 'failing' },
        ])

        await writeFile(join(root, 'tests/comments.test.ts'), titles(IDS), 'utf8')
        await writeFile(join(root, 'tests/more.test.ts'), '', 'utf8')
        expect((await recheck()).record.outcome).toBe('verified')
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })
  })

  describe('whether a migration covers the schema', () => {
    const GENERATE = 'drizzle-kit generate --config drizzle.config.ts --explain --output json'

    test('should fail db:migrate, without running it, on statements no migration covers, naming them', async () => {
      const fake = fakeExec({
        [GENERATE]: {
          stdout: `Reading config\n${JSON.stringify({ status: 'ok', statements: [{ type: 'create_table', table: { name: 'comments' } }, { type: 'add_column', column: { table: 'posts', name: 'edited_at' } }] })}\n`,
        },
      })

      const step = await verifier(statusOf(), fake).verify(DATA)

      expect(commandOf(step, 'db:migrate')).toMatchObject({
        status: 'fail',
        label: 'drizzle-kit generate --explain',
        reason: 'the schema has changes no migration covers: generate one with `guren make:migration`',
        findings: ['create_table comments', 'add_column posts.edited_at'],
      })
      expect(step.record.outcome).toBe('failed')
      expect(fake.calls.some((call) => call.includes('db:migrate'))).toBe(false)
    })

    test('should fail db:migrate where drizzle-kit needs a rename answered, since a migration is still missing', async () => {
      const fake = fakeExec({
        [GENERATE]: { exitCode: 2, stdout: `${JSON.stringify({ status: 'missing_hints', unresolved: [{ type: 'rename_or_create', kind: 'column', entity: ['public', 'posts', 'headline'] }] })}\n` },
      })

      const step = await verifier(statusOf(), fake).verify(DATA)

      expect(commandOf(step, 'db:migrate')).toMatchObject({ status: 'fail', findings: ['rename_or_create: column public.posts.headline'] })
    })

    test('should block db:migrate, never pass it, where drizzle-kit cannot say or is not there to ask', async () => {
      const failed = fakeExec({ [GENERATE]: { exitCode: 1, stdout: `${JSON.stringify({ status: 'error', error: { code: 'internal_error', message: '2 errors building db/schema.ts' } })}\n` } })
      const silent = fakeExec({ [GENERATE]: { exitCode: 1, stdout: '', stderr: "Unrecognized options for command 'generate': --explain\n" } })
      const slow = fakeExec({ [GENERATE]: { timedOut: true } })
      const wrote = fakeExec({ [GENERATE]: { stdout: `${JSON.stringify({ status: 'ok', dialect: 'postgresql', migration_path: 'drizzle/0001_x.sql' })}\n` } })

      const errored = await verifier(statusOf(), failed).verify(DATA)
      const unrecognized = await verifier(statusOf(), silent).verify(DATA)
      const timedOut = await verifier(statusOf(), slow).verify(DATA)
      const missing = await verifier(statusOf(), fakeExec(), { drizzleKit: async () => ({ missing: 'drizzle-kit is not installed in the application' }) }).verify(DATA)

      expect(commandOf(errored, 'db:migrate')).toMatchObject({ status: 'blocked', reason: expect.stringContaining(': internal_error: 2 errors building db/schema.ts') })
      expect(commandOf(unrecognized, 'db:migrate')).toMatchObject({ status: 'blocked', findings: ["Unrecognized options for command 'generate': --explain"] })
      expect(commandOf(timedOut, 'db:migrate').status).toBe('blocked')
      expect(commandOf(await verifier(statusOf(), wrote).verify(DATA), 'db:migrate')).toMatchObject({ status: 'blocked', reason: expect.stringContaining(': it wrote drizzle/0001_x.sql') })
      expect(commandOf(missing, 'db:migrate')).toMatchObject({ status: 'blocked', reason: 'cannot tell whether a migration covers the schema: drizzle-kit is not installed in the application' })
      expect(missing.record.outcome).toBe('blocked')
    })
  })

  test('should call a step failed when a command failed, whatever else was blocked', async () => {
    const fake = fakeExec({ 'run db:migrate': { exitCode: 1, stderr: 'ECONNREFUSED\n' }, 'run typecheck': { exitCode: 2, stdout: 'a.ts(1,1): error TS1\n' } })

    const step = await verifier(statusOf(), fake).verify(DATA)

    expect(commandsOf(step)).toEqual({ codegen: 'pass', 'db:migrate': 'blocked', typecheck: 'fail' })
    expect(step.record.outcome).toBe('failed')
  })

  test('should not run what reads the generated files once codegen did not pass', async () => {
    const fake = fakeExec({ 'run codegen': { exitCode: 1, stderr: 'error: pages/Bad.tsx has no default export\n' } })

    const step = await verifier(statusOf({ 'action.comments.destroy': { state: 'planned' } }), fake).verify(HTTP)

    expect(step.record.outcome).toBe('failed')
    expect(step.record.commands.map((command) => [command.command, command.status, command.label, command.reason])).toEqual([
      ['codegen', 'fail', 'bun run codegen', '`bun run codegen` exited 1'],
      ['check', 'blocked', 'not run', '`bun run codegen` did not pass, so this did not run'],
      ['tests', 'blocked', 'not run', '`bun run codegen` did not pass, so this did not run'],
    ])
    // A status judged behind a failed codegen would blame the code, so the record lists no incomplete element.
    expect(step.record.incomplete).toEqual([])
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

  test('should pass check over an unverified verdict and still name it, and why the app went unread', async () => {
    const unverified = checkReport([{
      key: 'introspection-unavailable',
      title: 'Introspection',
      status: 'warn',
      message: 'The app could not be introspected (timeout): The app did not finish loading and registering within 10000ms.',
      advisory: true,
    }, {
      key: 'sessions-binding-unverified',
      title: 'Session manager binding',
      status: 'warn',
      message: "whether a registered provider binds 'session' is unverified: BindingProvider threw in register().",
      advisory: true,
      evidence: 'none',
    }])

    const step = await verifier(statusOf(), fakeExec(), { check: async () => unverified }).verify(HTTP)

    expect(commandOf(step, 'check')).toMatchObject({
      status: 'pass',
      findings: [
        expect.stringMatching(/^Introspection \(advisory\): The app could not be introspected \(timeout\)/),
        expect.stringMatching(/^Session manager binding \(advisory\): .*BindingProvider threw/),
      ],
    })
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

const FINGERPRINT: PlanStepRecord['fingerprint'] = {
  files: { 'db/schema.ts': sha256(FILES['db/schema.ts']!), 'app/Models/Comment.ts': sha256(FILES['app/Models/Comment.ts']!) },
  environment: { runtime: 'bun 1.3.14', platform: 'darwin', arch: 'arm64', hostname: 'h' },
}

function record(overrides: Partial<PlanStepRecord> = {}): PlanStepRecord {
  return {
    outcome: 'verified',
    planDigest: 'digest',
    ranAt: '2026-09-21T00:00:00.000Z',
    durationMs: 1,
    commands: [],
    acceptance: [],
    incomplete: [],
    waived: [],
    fingerprint: FINGERPRINT,
    ...overrides,
  }
}

const DATA_FILES = ['db/schema.ts', 'app/Models/Comment.ts']

/** Posts listed on a page and shown as a resource, in two tasks: every clause a behaviour's reach follows, and three it does not. */
function reachPlan(): PlanDraft {
  const route = (id: string, method: string, path: string, action: string) => ({ id, change: { kind: 'add' }, method, path, name: id.slice(2), action, middleware: [], bind: [] })
  const action = (id: string, name: string, response: Record<string, unknown>) => ({ id, change: { kind: 'add' }, name, authorization: { middleware: [] }, response, rules: [] })
  const behaviour = (id: string, routeId: string, expect: Record<string, unknown> = {}) => ({ id, description: 'x', kind: 'success', actor: 'user', route: routeId, given: [], expect: { status: 200, ...expect } })
  return PlanDraftSchema.parse({
    planVersion: 1,
    title: 'Reach',
    summary: 'Reach fixture.',
    locale: 'en',
    scope: { goals: [], nonGoals: [] },
    models: [
      { id: 'm', change: { kind: 'existing' }, name: 'Post', table: 'posts', columns: [], relationships: [], fillable: [] },
      { id: 'm.user', change: { kind: 'existing' }, name: 'User', table: 'users', columns: [], relationships: [], fillable: [] },
    ],
    validators: [{ id: 'val', change: { kind: 'add' }, name: 'PostPayloadSchema', fields: [] }],
    controllers: [
      {
        id: 'ctl',
        change: { kind: 'add' },
        className: 'PostController',
        actions: [
          action('a.index', 'index', { kind: 'inertia', view: 'v.index' }),
          action('a.show', 'show', { kind: 'resource', resource: 'res.post' }),
          action('a.store', 'store', { kind: 'redirect', to: '/posts' }),
        ],
      },
    ],
    routes: [route('r.index', 'GET', '/posts', 'a.index'), route('r.show', 'GET', '/posts/:id', 'a.show'), route('r.store', 'POST', '/posts', 'a.store')],
    views: [
      {
        id: 'v.index',
        change: { kind: 'add' },
        page: 'posts/Index',
        purpose: 'List posts.',
        props: [{ name: 'authors', type: 'Data.User[]', resource: 'res.list' }],
        form: { validator: 'val', submitsTo: 'r.store', fields: [] },
        actions: [{ label: 'New', route: 'r.store' }],
        states: {},
      },
    ],
    resources: [
      { id: 'res.post', change: { kind: 'add' }, name: 'PostResource', model: 'm', fields: [] },
      { id: 'res.list', change: { kind: 'add' }, name: 'UserResource', model: 'm.user', fields: [] },
    ],
    tasks: [
      { id: 'task.list', entity: 'User', summary: 'The author resource.', covers: ['res.list'], acceptance: [] },
      {
        id: 'task.pages',
        entity: 'Post',
        summary: 'List and show posts.',
        covers: ['ctl', 'r.index', 'r.show', 'r.store', 'v.index', 'res.post', 'val'],
        acceptance: [behaviour('AC-show', 'r.show'), behaviour('AC-page', 'r.store', { inertia: 'v.index' }), behaviour('AC-index', 'r.index')],
      },
    ],
  })
}

describe('behaviourReach', () => {
  test('should reach the resource an action responds with', () => {
    const reached = behaviourReach(reachPlan(), ['AC-show'])
    expect([...reached].sort()).toEqual(['a.show', 'ctl', 'm', 'r.show', 'res.post'])
  })

  test('should reach the page a behaviour expects and the resources its props name, never its form or action routes', () => {
    const reached = behaviourReach(reachPlan(), ['AC-page'])
    expect(reached.has('v.index')).toBe(true)
    expect(reached.has('res.list')).toBe(true)
    // `r.store` is reached as the behaviour's own route; the form's validator is not, since `a.store` names none.
    expect(reached.has('val')).toBe(false)
    const index = behaviourReach(reachPlan(), ['AC-index'])
    expect(index.has('r.store') || index.has('val')).toBe(false)
  })

  test('should reach the page an action responds with', () => {
    const reached = behaviourReach(reachPlan(), ['AC-index'])
    expect(reached.has('v.index')).toBe(true)
    expect(reached.has('res.list')).toBe(true)
  })

  test('should lift an element of one task on the standing behaviours of another', async () => {
    const reach = reachPlan()
    const split = derivePlanTasks(reach)
    const steps = split.tasks.flatMap((task) => task.steps)
    const owner = steps.find((step) => step.elementIds.includes('res.list'))!
    const carrier = steps.find((step) => step.kind !== 'tests' && step.acceptanceIds.includes('AC-page'))!
    expect(split.tasks.find((task) => task.steps.includes(owner))).not.toBe(split.tasks.find((task) => task.steps.includes(carrier)))
    const file = 'app/Http/Controllers/CommentController.ts'
    const hashes = await hashFiles(ROOT, [file])
    const covered = record({ fingerprint: { ...FINGERPRINT, files: { [file]: sha256(FILES[file]!) } } })
    const judged = judgePlan(reach, planAppState())
    const elements = judged.elements.map((element): PlanElementStatus => ({ ...element, state: element.completesAt, files: [file], properties: [], notes: [] }))
    const status = { elements, summary: summarize(elements) }
    const listAfter = (records: Record<string, PlanStepRecord>) => elementOf(applyVerification(status, split, records, 'digest', hashes, reach).status, 'res.list').state

    expect(listAfter({ [owner.id]: covered })).toBe('present')
    expect(listAfter({ [owner.id]: covered, [carrier.id]: covered })).toBe('verified')
  })
})

describe('applyVerification', () => {
  test('should lift the elements of a verified step while its fingerprint still matches', async () => {
    const hashes = await hashFiles(ROOT, DATA_FILES)

    const { status, staleSteps } = applyVerification(statusOf(), derivation, { [DATA]: record() }, 'digest', hashes, plan)

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

    const { status } = applyVerification(statusOf(), derivation, { [DATA]: record() }, 'digest', hashes, plan)

    const column = elementOf(status, 'column.comment.id')
    expect(column.state).toBe('drifted')
    expect(column.notes).toEqual([`Verified 2026-09-21T00:00:00.000Z by ${DATA}; changed since: db/schema.ts.`])
  })

  test('should treat a file unreadable now, or unreadable when it was recorded, as a change', async () => {
    const hashes = await hashFiles(ROOT, [...DATA_FILES, 'db/missing.ts'])
    const withMissing = record({ fingerprint: { ...FINGERPRINT, files: { ...FINGERPRINT.files, 'db/missing.ts': 'abc' } } })
    const recordedNull = record({ fingerprint: { ...FINGERPRINT, files: { ...FINGERPRINT.files, 'db/schema.ts': null } } })

    const missing = applyVerification(statusOf(), derivation, { [DATA]: withMissing }, 'digest', hashes, plan)
    const unread = applyVerification(statusOf(), derivation, { [DATA]: recordedNull }, 'digest', hashes, plan)

    expect(elementOf(missing.status, 'column.comment.id').state).toBe('drifted')
    expect(elementOf(unread.status, 'column.comment.id').state).toBe('drifted')
  })

  test('should lift a drop, and an unjudged element only from a step with behaviours', async () => {
    const hashes = await hashFiles(ROOT, [...DATA_FILES, 'tests/comments.test.ts'])
    const unjudged = { state: 'unjudged' as const, files: [], properties: [] }
    const status = statusOf({ 'column.comment.id': { files: [] }, 'column.comment.body': unjudged, 'action.comments.store': unjudged })
    const dropped = elementOf(status, 'column.comment.id')
    dropped.change = 'drop'
    dropped.completesAt = 'present'
    const http = record({ fingerprint: { ...FINGERPRINT, files: { 'tests/comments.test.ts': sha256(FILES['tests/comments.test.ts']!) } } })

    const { status: lifted } = applyVerification(status, derivation, { [DATA]: record(), [HTTP]: http }, 'digest', hashes, plan)

    expect(elementOf(lifted, 'column.comment.id').state).toBe('verified')
    expect(elementOf(lifted, 'action.comments.store').state).toBe('verified')
    const body = elementOf(lifted, 'column.comment.body')
    expect(body.state).toBe('unjudged')
    expect(body.notes).toEqual([`Verified 2026-09-21T00:00:00.000Z by ${DATA}, but no planned property of it matched beyond its existence and no verified behaviour reaches it, so that result is not counted: no behaviour can reach it, so waive it.`])
  })

  test('should reach what a behaviour\u2019s route dispatches to and names, and nothing the plan does not link to it', () => {
    expect([...behaviourReach(plan, IDS)].sort()).toEqual([
      'action.comments.destroy',
      'action.comments.store',
      'controller.comments',
      'model.comment',
      'model.post',
      'policy.comment',
      'route.comments.destroy',
      'route.comments.store',
      'validator.comment',
    ])
    expect(behaviourReach(plan, ['AC-comments-1']).has('policy.comment')).toBe(false)
    expect(behaviourReach(plan, [])).toEqual(new Set())
  })

  test('should lift an element no planned property of which was read only from a step whose behaviours reach it', async () => {
    const controllerFile = 'app/Http/Controllers/CommentController.ts'
    const hashes = await hashFiles(ROOT, [controllerFile])
    const onExistence = { properties: [] }
    const status = statusOf({ 'controller.comments': onExistence, 'resource.comment': onExistence, 'validator.comment': { properties: [{ property: 'fields', verdict: 'unknown', planned: 'as planned', reason: 'no reader' }] } })
    const http = record({ fingerprint: { ...FINGERPRINT, files: { [controllerFile]: sha256(FILES[controllerFile]!) } } })

    const { status: lifted } = applyVerification(status, derivation, { [HTTP]: http }, 'digest', hashes, plan)

    expect(elementOf(lifted, 'controller.comments').state).toBe('verified')
    expect(elementOf(lifted, 'validator.comment').state).toBe('verified')
    const resource = elementOf(lifted, 'resource.comment')
    expect(resource.state).toBe('present')
    expect(resource.notes).toEqual([`Verified 2026-09-21T00:00:00.000Z by ${HTTP}, but no planned property of it matched beyond its existence and no verified behaviour reaches it, so that result is not counted: add a behaviour that reaches it, or waive it.`])
    // A matched element with no file is held by its fingerprint, and a changed file expires a verified one.
    const unfingerprinted = applyVerification(statusOf({ 'controller.comments': { files: [] } }), derivation, { [HTTP]: http }, 'digest', hashes, plan).status
    expect(elementOf(unfingerprinted, 'controller.comments')).toMatchObject({ state: 'present', hold: { kind: 'unfingerprinted' } })
    const changedHashes = new Map([[controllerFile, 'changed']])
    const changedRun = applyVerification(statusOf(), derivation, { [HTTP]: http }, 'digest', changedHashes, plan).status
    expect(elementOf(changedRun, 'controller.comments')).toMatchObject({ state: 'drifted', hold: { kind: 'expired' } })
    // An element no behaviour reaches is held by that, before its changed file: a run cannot lift it either way.
    const unreachedChanged = applyVerification(statusOf({ 'resource.comment': { properties: [] } }), derivation, { [HTTP]: http }, 'digest', changedHashes, plan).status
    expect(elementOf(unreachedChanged, 'resource.comment')).toMatchObject({ state: 'present', hold: { kind: 'unreached' } })
    // With no file either, what holds it is still the missing behaviour: a run could fingerprint nothing more.
    const bare = applyVerification(statusOf({ 'resource.comment': { properties: [], files: [] } }), derivation, { [HTTP]: http }, 'digest', hashes, plan).status
    expect(elementOf(bare, 'resource.comment').hold?.kind).toBe('unreached')
    // A property a reader matched is a reading of the change itself, which needs no behaviour to reach it.
    expect(elementOf(applyVerification(statusOf(), derivation, { [HTTP]: http }, 'digest', hashes, plan).status, 'resource.comment').state).toBe('verified')
    // A field's existence alone is not: it says nothing of the planned shape.
    const onKeys = statusOf({ 'resource.comment': { properties: [{ property: 'field body', verdict: 'match', planned: 'declared', actual: 'declared', existence: true }] } })
    expect(elementOf(applyVerification(onKeys, derivation, { [HTTP]: http }, 'digest', hashes, plan).status, 'resource.comment').hold?.kind).toBe('unreached')
  })

  test('should name the step whose behaviours reach an element, not ask for a behaviour, when that step has no standing run', async () => {
    const controllerFile = 'app/Http/Controllers/CommentController.ts'
    const http = record({ fingerprint: { ...FINGERPRINT, files: { [controllerFile]: sha256(FILES[controllerFile]!) } } })
    const changedHashes = new Map([[controllerFile, 'changed']])

    const drifted = applyVerification(statusOf({ 'controller.comments': { properties: [] } }), derivation, { [HTTP]: http }, 'digest', changedHashes, plan).status
    const controller = elementOf(drifted, 'controller.comments')
    expect(controller).toMatchObject({ state: 'present', hold: { kind: 'unreached' } })
    expect(controller.notes).toEqual([
      `Verified 2026-09-21T00:00:00.000Z by ${HTTP}, but no planned property of it matched beyond its existence and no verified run of a step whose behaviours reach it (${HTTP}) holds now, so that result is not counted: run plan:verify on that step, or waive it.`,
    ])

    // Verified by its own step, reached only through another step that never ran.
    const hashes = await hashFiles(ROOT, DATA_FILES)
    const unrun = applyVerification(statusOf({ 'model.comment': { properties: [] } }), derivation, { [DATA]: record() }, 'digest', hashes, plan).status
    const model = elementOf(unrun, 'model.comment')
    expect(model.hold?.kind).toBe('unreached')
    expect(model.hold?.note).toContain(`reach it (${HTTP}) holds now`)
    expect(model.hold?.note).not.toContain('add a behaviour')

    // Two steps carrying the same behaviours: either one's run would lift it.
    const twice = { ...derivation, tasks: derivation.tasks.map((task) => ({ ...task, steps: task.steps.flatMap((step) => (step.id === HTTP ? [step, { ...step, id: `${HTTP}-again` }] : [step])) })) }
    const both = elementOf(applyVerification(statusOf({ 'controller.comments': { properties: [] } }), twice, { [HTTP]: http }, 'digest', changedHashes, plan).status, 'controller.comments')
    expect(both.hold?.note).toEndWith(`reach it (${HTTP}, ${HTTP}-again) holds now, so that result is not counted: run plan:verify on one of those steps, or waive it.`)
  })

  test('should offer only a waiver for an element whose reaching step has no standing run and that plan:verify cannot fingerprint', () => {
    const controllerFile = 'app/Http/Controllers/CommentController.ts'
    const http = record({ fingerprint: { ...FINGERPRINT, files: { [controllerFile]: sha256(FILES[controllerFile]!) } } })

    const { status } = applyVerification(statusOf({ 'controller.comments': { properties: [], files: [] } }), derivation, { [HTTP]: http }, 'digest', new Map([[controllerFile, 'changed']]), plan)

    const controller = elementOf(status, 'controller.comments')
    expect(controller.hold?.kind).toBe('unreached')
    expect(controller.hold?.note).toBe(
      `Verified 2026-09-21T00:00:00.000Z by ${HTTP}, but no planned property of it matched beyond its existence and no verified run of a step whose behaviours reach it (${HTTP}) holds now, and plan:verify cannot fingerprint it, so that result is not counted: waive it.`,
    )
    const [blocker] = describeCloseBlockers(plan, derivation, [controller], 'plan.json')
    expect(blocker?.moves).toStartWith('plan:verify cannot fingerprint it, so no run lifts it: waive it with')
  })

  test('should send an unjudged element with no file back to the step whose behaviours reach it, since its run needs no file of it', () => {
    const testFile = 'tests/comments.test.ts'
    const status = statusOf({ 'action.comments.store': { state: 'unjudged', files: [], properties: [] } })
    const http = record({ fingerprint: { ...FINGERPRINT, files: { [testFile]: sha256(FILES[testFile]!) } } })

    const { status: held } = applyVerification(status, derivation, { [HTTP]: http }, 'digest', new Map([[testFile, 'changed']]), plan)

    const action = elementOf(held, 'action.comments.store')
    expect(action.hold?.kind).toBe('unreached')
    expect(action.hold?.note).toEndWith(`reach it (${HTTP}) holds now, so that result is not counted: run plan:verify on that step, or waive it.`)
  })

  test('should reach an element of a split step\u2019s earlier part through the part that runs the behaviours, while its record stands', async () => {
    const controllerFile = 'app/Http/Controllers/CommentController.ts'
    const split = derivePlanTasks(plan, { splitThreshold: 3 })
    const [first, last] = ['task/entity/model.comment/http/1', 'task/entity/model.comment/http/2']
    expect(findPlanStep(split, first)?.step.acceptanceIds).toEqual([])
    expect(findPlanStep(split, first)?.step.elementIds).toContain('controller.comments')
    expect(findPlanStep(split, last)?.step.acceptanceIds).toEqual(IDS)
    const hashes = await hashFiles(ROOT, [controllerFile])
    const covered = { ...FINGERPRINT, files: { [controllerFile]: sha256(FILES[controllerFile]!) } }
    const status = statusOf({ 'controller.comments': { properties: [] } })
    const controllerAfter = (records: Record<string, PlanStepRecord>) => elementOf(applyVerification(status, split, records, 'digest', hashes, plan).status, 'controller.comments').state

    expect(controllerAfter({ [first]: record({ fingerprint: covered }) })).toBe('present')
    // The tests step verifies by seeing its behaviours fail, which exercises nothing of the implementation.
    expect(controllerAfter({ [first]: record({ fingerprint: covered }), [TESTS]: record({ fingerprint: covered }) })).toBe('present')
    expect(controllerAfter({ [first]: record({ fingerprint: covered }), [last]: record({ fingerprint: covered }) })).toBe('verified')
    expect(controllerAfter({ [first]: record({ fingerprint: covered }), [last]: record({ fingerprint: covered, outcome: 'failed' }) })).toBe('present')
    expect(controllerAfter({ [first]: record({ fingerprint: covered }), [last]: record({ fingerprint: { ...covered, files: { [controllerFile]: 'older' } } }) })).toBe('present')
  })

  test('should call a record drifted only where changed files are all that keep it from standing', async () => {
    const hashes = await hashFiles(ROOT, DATA_FILES)
    const changed = new Map([...hashes, ['db/schema.ts', 'other']])

    expect(recordDrift(record(), 'digest', changed)).toEqual(['db/schema.ts'])
    expect(recordStillHolds(record(), 'digest', changed)).toBe(false)
    expect(recordDrift(record(), 'digest', hashes)).toEqual([])
    expect(recordDrift(record({ outcome: 'failed' }), 'digest', changed)).toEqual([])
    expect(recordDrift(record({ planDigest: 'older' }), 'digest', changed)).toEqual([])
    expect(recordDrift(record({ waived: ['policy.comment'] }), 'digest', changed)).toEqual([])
    expect(recordDrift(record({ waived: ['policy.comment'] }), 'digest', changed, new Set(['policy.comment']))).toEqual(['db/schema.ts'])
  })

  test('should let a record stand while every fingerprinted file still matches, an empty fingerprint on the plan digest alone', async () => {
    const hashes = await hashFiles(ROOT, DATA_FILES)
    const empty = record({ fingerprint: { ...FINGERPRINT, files: {} } })

    expect(recordStillHolds(record(), 'digest', hashes)).toBe(true)
    expect(recordStillHolds(record({ planDigest: 'older' }), 'digest', hashes)).toBe(false)
    expect(recordStillHolds(record({ outcome: 'incomplete' }), 'digest', hashes)).toBe(false)
    expect(recordStillHolds(record({ fingerprint: { ...FINGERPRINT, files: { ...FINGERPRINT.files, 'db/schema.ts': null } } }), 'digest', hashes)).toBe(false)
    expect(recordStillHolds(record(), 'digest', new Map([...hashes, ['db/schema.ts', 'other']]))).toBe(false)
    // A scaffold step or a drop has nothing to fingerprint: the record stands until the plan changes, or the loop could never end.
    expect(recordStillHolds(empty, 'digest', hashes)).toBe(true)
    expect(recordStillHolds({ ...empty, planDigest: 'older' }, 'digest', hashes)).toBe(false)
    expect(recordStillHolds({ ...empty, outcome: 'incomplete' }, 'digest', hashes)).toBe(false)

    // A record that rested on a waiver retires with it, or the loop would skip a step nobody accepted any more.
    const onWaiver = record({ waived: ['policy.comment'] })
    expect(recordStillHolds(onWaiver, 'digest', hashes, new Set(['policy.comment']))).toBe(true)
    expect(recordStillHolds(onWaiver, 'digest', hashes, new Set(['resource.comment']))).toBe(false)
    expect(recordStillHolds(onWaiver, 'digest', hashes)).toBe(false)
  })

  test('should lift nothing of an element the fingerprint does not cover', async () => {
    const hashes = await hashFiles(ROOT, DATA_FILES)
    const noFiles = statusOf({ 'column.comment.id': { files: [] } })
    const elsewhere = statusOf({ 'column.comment.id': { files: ['modules/billing/db/schema.ts'] } })

    const unfingerprinted = applyVerification(noFiles, derivation, { [DATA]: record() }, 'digest', hashes, plan)
    const moved = applyVerification(elsewhere, derivation, { [DATA]: record() }, 'digest', hashes, plan)
    const empty = applyVerification(statusOf(), derivation, { [DATA]: record({ fingerprint: { ...FINGERPRINT, files: {} } }) }, 'digest', hashes, plan)

    const column = elementOf(unfingerprinted.status, 'column.comment.id')
    expect(column.state).toBe('present')
    expect(column.notes).toEqual([`Verified 2026-09-21T00:00:00.000Z by ${DATA}, and nothing of it was fingerprinted, so that result could not expire and is not counted.`])
    expect(elementOf(unfingerprinted.status, 'model.comment').state).toBe('verified')
    const movedColumn = elementOf(moved.status, 'column.comment.id')
    expect(movedColumn.state).toBe('drifted')
    expect(movedColumn.notes).toEqual([`Verified 2026-09-21T00:00:00.000Z by ${DATA}; now in a file that run did not fingerprint: modules/billing/db/schema.ts.`])
    expect(empty.status.summary.states.verified).toBe(0)
  })

  test('should lift nothing from a record of another plan digest, and say which step', async () => {
    const hashes = await hashFiles(ROOT, DATA_FILES)

    const { status, staleSteps } = applyVerification(statusOf(), derivation, { [DATA]: record({ planDigest: 'older' }) }, 'digest', hashes, plan)

    expect(elementOf(status, 'column.comment.id').state).toBe('present')
    expect(staleSteps).toEqual([DATA])
  })

  test('should lift nothing from a record that did not verify, and leave an element the code has lost with a note', async () => {
    const hashes = await hashFiles(ROOT, DATA_FILES)

    const failed = applyVerification(statusOf(), derivation, { [DATA]: record({ outcome: 'failed' }) }, 'digest', hashes, plan)
    const lost = applyVerification(statusOf({ 'column.comment.id': { state: 'planned' } }), derivation, { [DATA]: record() }, 'digest', hashes, plan)

    expect(failed.status.summary.states.verified).toBe(0)
    const column = elementOf(lost.status, 'column.comment.id')
    expect(column.state).toBe('planned')
    expect(column.notes).toEqual([`Verified 2026-09-21T00:00:00.000Z by ${DATA}, and no longer at the state that completes it.`])
  })

  test('should not touch the status it was given', async () => {
    const status = statusOf()
    const before = JSON.stringify(status)

    applyVerification(status, derivation, { [DATA]: record() }, 'digest', await hashFiles(ROOT, DATA_FILES), plan)

    expect(JSON.stringify(status)).toBe(before)
  })
})

describe('applyWaivers', () => {
  function waiver(elementId: string, overrides: Partial<PlanWaiver> = {}): PlanWaiver {
    return { elementId, planHash: 'hash', reason: 'the redesign lands in the next plan', at: '2026-09-21T12:00:00.000Z', ...overrides }
  }

  test('should lift a waived element whatever the readers found, with the reason and the date', () => {
    const status = statusOf({ 'policy.comment': { state: 'planned' }, 'model.comment': { state: 'drifted' } })
    // What held it back is answered by the waiver, so it does not travel with the waived element.
    elementOf(status, 'model.comment').hold = { kind: 'expired', note: 'Verified t by s; changed since: a.ts.' }

    const lifted = applyWaivers(status, new Map([['policy.comment', waiver('policy.comment', { by: 'Urata Daiki <someone@example.com>' })], ['model.comment', waiver('model.comment')]]))

    const policy = elementOf(lifted, 'policy.comment')
    expect(policy.state).toBe('waived')
    expect(policy.notes).toEqual(['Waived 2026-09-21T12:00:00.000Z by Urata Daiki <someone@example.com>: the redesign lands in the next plan'])
    expect(elementOf(lifted, 'model.comment').state).toBe('waived')
    expect(elementOf(lifted, 'model.comment').hold).toBeUndefined()
    expect(elementOf(lifted, 'model.comment').notes).toEqual(['Waived 2026-09-21T12:00:00.000Z: the redesign lands in the next plan'])
    expect(lifted.summary.states.waived).toBe(2)
  })

  test('should leave a verified element verified, and say the waiver is not needed', async () => {
    const verified = applyVerification(statusOf(), derivation, { [DATA]: record() }, 'digest', await hashFiles(ROOT, DATA_FILES), plan).status

    const lifted = applyWaivers(verified, new Map([['model.comment', waiver('model.comment')]]))

    const model = elementOf(lifted, 'model.comment')
    expect(model.state).toBe('verified')
    expect(model.notes).toContain('Waived 2026-09-21T12:00:00.000Z: the redesign lands in the next plan. It is verified, so the waiver is not needed.')
    expect(lifted.summary.states.waived).toBe(0)
  })

  test('should leave an existing element alone, which a hand-edited log is the only way to waive', () => {
    const status = statusOf({ 'column.post.id': { state: 'present' } })

    const lifted = applyWaivers(status, new Map([['column.post.id', waiver('column.post.id')]]))

    const column = elementOf(lifted, 'column.post.id')
    expect(column.state).toBe('present')
    expect(column.notes).toContain('Waived 2026-09-21T12:00:00.000Z: the redesign lands in the next plan. It is an existing element, no part of completion, so the waiver is not needed.')
    expect(lifted.summary.states.waived).toBe(0)
  })

  test('should not touch the status it was given', () => {
    const status = statusOf({ 'policy.comment': { state: 'planned' } })
    const before = JSON.stringify(status)

    applyWaivers(status, new Map([['policy.comment', waiver('policy.comment')]]))

    expect(JSON.stringify(status)).toBe(before)
  })
})

describe('overlayVerification', () => {
  test('should report the log the caller already read rather than reading it again', async () => {
    const passed = { elementId: 'policy.comment', planHash: 'another-revision', reason: 'later', at: '2026-09-21T12:00:00.000Z' }
    // Nothing of this is on disk under ROOT, so a second read would answer with none of it.
    const waivers = { waivers: new Map(), waived: new Set<string>(), stale: [passed], unreadable: 'passed in' }

    const overlaid = await overlayVerification(ROOT, join(ROOT, 'seam.plan.json'), plan, statusOf(), derivation, { waivers })

    expect(overlaid.verification.staleWaivers).toEqual([passed])
    expect(overlaid.verification.decisionsUnreadable).toBe('passed in')
    expect(overlaid.verification.decisionsFile).toBe('seam.decisions.json')
  })
})

describe('planWaivers', () => {
  const APPROVED = loadParsedCommentsPlan()
  const HASH = planHash(APPROVED)

  function waiver(elementId: string, planHash: string): PlanWaiver {
    return { elementId, planHash, reason: 'later', at: '2026-09-21T12:00:00.000Z' }
  }

  test('should keep the waivers of this plan and report the ones of another revision as stale', () => {
    const decisions = { decisionsVersion: 1 as const, waivers: [waiver('policy.comment', HASH), waiver('model.comment', 'another-revision')] }

    const { waivers, stale } = planWaivers(APPROVED, decisions)

    expect([...waivers.keys()]).toEqual(['policy.comment'])
    expect(stale.map((entry) => entry.elementId)).toEqual(['model.comment'])
  })

  test('should lift nothing for a draft, which has no hash a waiver could name', () => {
    const draft = PlanDraftSchema.parse(loadCommentsPlan())
    const decisions = { decisionsVersion: 1 as const, waivers: [waiver('policy.comment', HASH)] }

    const { waivers, stale } = planWaivers(draft, decisions)

    expect(waivers.size).toBe(0)
    expect(stale.map((entry) => entry.elementId)).toEqual(['policy.comment'])
  })
})

describe('plan state', () => {
  test('should name the state file after the plan file, without its extensions, and a plan.json after its directory', () => {
    expect(planSlug('/x/comments.plan.json')).toBe('comments')
    expect(planSlug('comments.json')).toBe('comments')
    expect(planSlug('docs/plans/comments/plan.json')).toBe('comments')
    expect(planSlug('docs/plans/billing/plan.json')).not.toBe(planSlug('docs/plans/comments/plan.json'))
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
      expect(await readFile(join(root, '.guren/plans/.gitignore'), 'utf8')).toBe(PLAN_STATE_GITIGNORE)
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

describe('formatPlanVerify', () => {
  test('should say when the status was judged behind a failed codegen', () => {
    const failed = record({ outcome: 'failed', commands: [{ command: 'codegen', label: 'bun run codegen', status: 'fail', durationMs: 3, reason: '`bun run codegen` exited 1', findings: ['error: no'] }] })
    const passed = record({ commands: [{ command: 'codegen', label: 'bun run codegen', status: 'pass', durationMs: 3, findings: [] }] })
    const report = (steps: Array<[string, PlanStepRecord]>): PlanVerifyReport => ({
      reportVersion: PLAN_STATUS_REPORT_VERSION,
      plan: { file: 'comments.plan.json', title: 'Comments', hash: null },
      elements: [],
      summary: summarize([]),
      verification: { stateFile: '.guren/plans/comments.state.json', staleSteps: [], decisionsFile: 'comments.decisions.json', staleWaivers: [] },
      steps: steps.map(([stepId, entry]) => ({ stepId, taskId: 'task/entity/model.comment', record: entry })),
      skipped: [],
      reverified: [],
      recheckPending: [],
    })

    const behind = formatPlanVerify(report([[DATA, failed], [HTTP, passed]]))
    const clean = formatPlanVerify(report([[HTTP, passed]]))

    expect(behind).toContain(`codegen did not pass in ${DATA}, so the status below was judged without the generated files.`)
    expect(behind).toContain('  fail     codegen     bun run codegen\n      `bun run codegen` exited 1\n      error: no')
    expect(clean).not.toContain('judged without the generated files')
  })

  test('should name the steps it re-checked and the ones it left for a later run', () => {
    const report = (reverified: string[], recheckPending: string[]): PlanVerifyReport => ({
      reportVersion: PLAN_STATUS_REPORT_VERSION,
      plan: { file: 'comments.plan.json', title: 'Comments', hash: null },
      elements: [],
      summary: summarize([]),
      verification: { stateFile: '.guren/plans/comments.state.json', staleSteps: [], decisionsFile: 'comments.decisions.json', staleWaivers: [] },
      steps: [],
      skipped: [],
      reverified,
      recheckPending,
    })

    const text = formatPlanVerify(report([DATA], [HTTP]))

    expect(text).toContain(`Re-checked, since files they were verified at have changed: ${DATA}`)
    expect(text).toContain(`Left verified for a later run to re-check (a step they share commands with did not verify, the re-check was blocked, or a static re-check failed): ${HTTP}`)
    expect(formatPlanVerify(report([], []))).not.toContain('Re-checked')
    expect(formatPlanVerify(report([], []))).not.toContain('Left verified')
  })
})
