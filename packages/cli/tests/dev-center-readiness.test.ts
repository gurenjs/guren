import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { readdir, readFile, rm } from 'node:fs/promises'
import { join, relative } from 'node:path'

import { createDevCenterHandler } from '../src/dev-center'
import { planReadinessPath, planReadinessRoute } from '../src/dev-center-links'
import { runReadinessChild, type PlanReadiness, type ReadinessRunner } from '../src/dev-center-readiness'
import { planWaiveFile } from '../src/plan-waive'
import { listPlanElements, PlanSchema } from '../src/plan/schema'
import { gurenCommandLine, shellQuote } from '../src/shell-quote'
import { createTempRoot, writeWorkspaceFiles } from './helpers'
import { approvePlanFile, loadApprovedCommentsPlan, loadCommentsPlan, PLAN_APP_FILES } from './plan-fixture'

const ORIGIN = 'http://localhost:3000'
const DRAFT = 'docs/plans/draft.plan.json'
const APPROVED = 'docs/plans/comments.plan.json'
let ROOT: string

beforeAll(async () => {
  ROOT = await createTempRoot('guren-dev-center-readiness-')
})

afterAll(async () => {
  await rm(ROOT, { recursive: true, force: true })
})

function git(dir: string, ...args: string[]): void {
  const result = Bun.spawnSync(['git', '-c', 'user.name=Approver', '-c', 'user.email=approver@example.com', ...args], { cwd: dir, stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr.toString()}`)
}

/**
 * A committed app holding an answered draft and an approved plan; bunfig stops Bun installing what it cannot resolve.
 * `closable` waives every element `plan:waive` takes, so `plan:close` would go through.
 */
async function createApp(name: string, { closable = false } = {}): Promise<string> {
  const app = join(ROOT, name)
  await writeWorkspaceFiles(app, {
    'bunfig.toml': '[install]\nauto = "disable"\n',
    ...PLAN_APP_FILES,
    [DRAFT]: JSON.stringify({ ...loadCommentsPlan(), questions: [] }),
    [APPROVED]: JSON.stringify(loadApprovedCommentsPlan()),
  })
  await approvePlanFile(join(app, APPROVED))
  if (closable) {
    for (const { id } of listPlanElements(PlanSchema.parse(loadApprovedCommentsPlan()))) {
      await planWaiveFile(join(app, APPROVED), { elementIds: [id], reason: 'closing the fixture' }).catch(() => undefined)
    }
  }
  git(app, 'init', '-q')
  git(app, 'add', '-A')
  git(app, 'commit', '-q', '-m', 'init')
  return app
}

async function snapshot(dir: string): Promise<Map<string, string>> {
  const files = new Map<string, string>()
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue
    const path = relative(dir, join(entry.parentPath, entry.name))
    if (path.split('/')[0] === '.git') continue
    files.set(path, await readFile(join(dir, path), 'utf8'))
  }
  return files
}

async function check(app: string, path: string, run?: ReadinessRunner): Promise<{ status: number; body: PlanReadiness & { error?: { code: string } } }> {
  const response = await createDevCenterHandler({ cwd: app, readiness: run }).fetch(new Request(`${ORIGIN}${path}`))
  return { status: response.status, body: await response.json() as PlanReadiness & { error?: { code: string } } }
}

const answering = (child: Awaited<ReturnType<ReadinessRunner>>, calls: Array<{ argv: string[]; env: NodeJS.ProcessEnv }> = []): ReadinessRunner =>
  async (argv, _cwd, env) => {
    calls.push({ argv, env })
    return child
  }

describe('readiness paths', () => {
  test('should round-trip a slug and decision, and name one element for a waiver', () => {
    expect(planReadinessPath('a b', 'approve')).toBe('/_guren/plans/a%20b/readiness/approve')
    expect(planReadinessPath('comments', 'waive', 'model.comment')).toBe('/_guren/plans/comments/readiness/waive?element=model.comment')
    expect(planReadinessRoute('/_guren/plans/a%20b/readiness/close')).toEqual({ slug: 'a b', decision: 'close' })
    expect(planReadinessRoute('/_guren/plans/comments/readiness/revise')).toBeUndefined()
  })
})

describe('the readiness check', () => {
  let app: string
  beforeAll(async () => {
    app = await createApp('unit')
  })

  test('should run the command with --dry-run and GUREN_PLAN_DRY_RUN=1, and read its report as ready', async () => {
    const calls: Array<{ argv: string[]; env: NodeJS.ProcessEnv }> = []
    const { status, body } = await check(app, planReadinessPath('comments', 'waive', 'model.comment'), answering({ exitCode: 0, stdout: '{"dryRun":true,"written":true}', stderr: '' }, calls))

    expect(status).toBe(200)
    expect(body).toMatchObject({ status: 'ready', decision: 'waive', element: 'model.comment', args: ['plan:waive', APPROVED, 'model.comment'], report: { dryRun: true } })
    expect(calls[0]!.argv).toEqual(['plan:waive', APPROVED, 'model.comment', '--dry-run', '--json', '--app', app])
    expect(calls[0]!.env.GUREN_PLAN_DRY_RUN).toBe('1')
  })

  test('should read a refusal from stderr, and never read anything else as ready', async () => {
    const refused = await check(app, planReadinessPath('draft', 'close'), answering({ exitCode: 1, stdout: '', stderr: '\n ERROR  docs/plans/draft.plan.json is a draft.\n' }))
    expect(refused.body).toMatchObject({ status: 'refused', message: 'docs/plans/draft.plan.json is a draft.' })

    const notDry = await check(app, planReadinessPath('draft', 'approve'), answering({ exitCode: 0, stdout: '{"dryRun":false}', stderr: '' }))
    expect(notDry.body.status).toBe('unavailable')
    const garbled = await check(app, planReadinessPath('draft', 'approve'), answering({ exitCode: 0, stdout: 'not json', stderr: '' }))
    expect(garbled.body.status).toBe('unavailable')
    const stopped = await check(app, planReadinessPath('draft', 'approve'), answering({ exitCode: null, stdout: '', stderr: '', failed: 'The check took too long or was stopped.' }))
    expect(stopped.body).toMatchObject({ status: 'unavailable', message: 'The check took too long or was stopped.' })
    const silent = await check(app, planReadinessPath('draft', 'approve'), answering({ exitCode: 2, stdout: '', stderr: '' }))
    expect(silent.body.status).toBe('unavailable')
    const crashed = await check(app, planReadinessPath('draft', 'approve'), answering({ exitCode: 1, stdout: '', stderr: ' ERROR  boom\n    at load (src/x.ts:1:1)\n' }))
    expect(crashed.body).toMatchObject({ status: 'unavailable', message: expect.stringContaining('crashed') })
    // An app module that prints at import comes before the report, which is still read.
    const noisy = await check(app, planReadinessPath('draft', 'approve'), answering({ exitCode: 0, stdout: 'booting {x}\n{\n  "dryRun": true\n}\n', stderr: '' }))
    expect(noisy.body.status).toBe('ready')
  })

  test('should start no child for an element the plan does not declare, a missing one, or another method', async () => {
    const calls: Array<{ argv: string[]; env: NodeJS.ProcessEnv }> = []
    const runner = answering({ exitCode: 0, stdout: '{"dryRun":true}', stderr: '' }, calls)
    expect((await check(app, planReadinessPath('comments', 'waive', '--reason=x'), runner)).status).toBe(400)
    expect((await check(app, planReadinessPath('comments', 'waive'), runner)).status).toBe(400)
    expect((await check(app, planReadinessPath('nothing', 'approve'), runner)).status).toBe(404)
    const post = await createDevCenterHandler({ cwd: app, readiness: runner }).fetch(new Request(`${ORIGIN}${planReadinessPath('draft', 'approve')}`, { method: 'POST' }))
    expect(post.status).toBe(405)
    expect(calls).toHaveLength(0)
  })
})

describe('the readiness check against the real CLI', () => {
  // A waiver needs a reason before it reaches its writer, which the page never sends; the guard is the writer's.
  const dropFlag: ReadinessRunner = (argv, cwd, env) =>
    runReadinessChild([...argv.filter((arg) => arg !== '--dry-run'), ...(argv[0] === 'plan:waive' ? ['--reason', 'x'] : [])], cwd, env)
  const dropEnv: ReadinessRunner = (argv, cwd, env) => {
    const { GUREN_PLAN_DRY_RUN: _dropped, ...rest } = env
    return runReadinessChild(argv, cwd, rest)
  }

  test('should leave every file byte for byte, and answer each decision', async () => {
    const app = await createApp('real')
    const before = await snapshot(app)

    const approve = await check(app, planReadinessPath('draft', 'approve'))
    expect(approve.body).toMatchObject({ status: 'ready', report: { dryRun: true, alreadyApproved: false } })
    const waive = await check(app, planReadinessPath('comments', 'waive', 'model.comment'))
    expect(waive.body).toMatchObject({ status: 'ready', report: { dryRun: true, written: true } })
    const close = await check(app, planReadinessPath('comments', 'close'))
    expect(close.body.status).toBe('refused')

    expect(await snapshot(app)).toEqual(before)
  }, 120_000)

  test('should write nothing with --dry-run dropped from the argv, since the writers refuse under the flag', async () => {
    const app = await createApp('no-flag')
    const before = await snapshot(app)

    const approve = await check(app, planReadinessPath('draft', 'approve'), dropFlag)
    expect(approve.body).toMatchObject({ status: 'refused', message: expect.stringContaining('GUREN_PLAN_DRY_RUN=1 is set') })
    const waive = await check(app, planReadinessPath('comments', 'waive', 'model.comment'), dropFlag)
    expect(waive.body).toMatchObject({ status: 'refused', message: expect.stringContaining('GUREN_PLAN_DRY_RUN=1 is set') })

    expect(await snapshot(app)).toEqual(before)
  }, 120_000)

  test('should close nothing with --dry-run dropped from the argv, and answer ready with it', async () => {
    const app = await createApp('closable', { closable: true })
    const before = await snapshot(app)

    expect((await check(app, planReadinessPath('comments', 'close'))).body).toMatchObject({ status: 'ready', report: { dryRun: true } })
    const dropped = await check(app, planReadinessPath('comments', 'close'), dropFlag)
    expect(dropped.body).toMatchObject({ status: 'refused', message: expect.stringContaining('GUREN_PLAN_DRY_RUN=1 is set') })

    expect(await snapshot(app)).toEqual(before)
  }, 120_000)

  test('should write nothing with the flag dropped from the environment, since --dry-run alone holds', async () => {
    const app = await createApp('no-env')
    const before = await snapshot(app)

    expect((await check(app, planReadinessPath('draft', 'approve'), dropEnv)).body.status).toBe('ready')
    expect((await check(app, planReadinessPath('comments', 'waive', 'model.comment'), dropEnv)).body.status).toBe('ready')

    expect(await snapshot(app)).toEqual(before)
  }, 120_000)
})

describe('the command a person pastes', () => {
  test('should quote a reason so a shell reads it as text', () => {
    const reason = `it's $(rm -rf ~) and \`id\`\nlater`
    const line = gurenCommandLine(['plan:waive', 'docs/plans/comments.plan.json', 'model.comment', '--reason', reason])
    expect(line).toBe(`bunx guren plan:waive docs/plans/comments.plan.json model.comment --reason ${shellQuote(reason)}`)
    const echoed = Bun.spawnSync(['sh', '-c', `printf %s ${shellQuote(reason)}`], { stdout: 'pipe' })
    expect(echoed.stdout.toString()).toBe(reason)
  })
})
