import { afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { runCommand, type CommandDef } from 'citty'

import { builtinSubCommands } from '../src/commands'
import { parsePlanDocument } from '../src/plan-render'
import { formatPlanScaffold, planScaffoldFile, planScaffoldMountFile, type PlanScaffoldReport } from '../src/plan-scaffold'
import type { PlanVerifyReport } from '../src/plan-verify'
import { ParseCache } from '../src/parse-cache'
import { emitPlanTests, PLAN_TESTS_CSRF_ABSENT, type PlanTestsApp } from '../src/plan/scaffold-tests'
import { writePlanActiveStep } from '../src/plan/state'
import { derivePlanTasks, findPlanStep } from '../src/plan/tasks'
import { acceptanceTestFiles } from '../src/plan/verify'
import { scanTestRequests, testCoverage } from '../src/test-requests'
import { checkTypes, createTempRoot, linkWorkspaceCore, linkWorkspacePackage, snapshotTree, templateCompilerOptions, TSC_TIMEOUT, writeWorkspaceFiles } from './helpers'
import { approvedAgainst, approvePlanFile, loadCommentsPlan, PLAN_APP_FILES, refusal } from './plan-fixture'

const WORKSPACE_DRIZZLE = resolve(import.meta.dir, '../../orm/node_modules/drizzle-orm')
const WORKSPACE_ZOD = resolve(import.meta.dir, '../node_modules/zod')
const TESTING_TYPES = resolve(import.meta.dir, '../../testing/dist/index.d.ts')
const TESTING_SOURCE = resolve(import.meta.dir, '../../testing/src/test-app.ts')

const PLAN_FILE = 'comments.plan.json'
const TASK = 'task/entity/model.comment'
const SCAFFOLD = `${TASK}/scaffold`
const TESTS = `${TASK}/tests`
const HTTP = `${TASK}/http`
const TEST_FILE = 'tests/plans/comments/comments.test.ts'
const IDS = ['AC-comments-1', 'AC-comments-2', 'AC-comments-3', 'AC-comments-4', 'AC-comments-5']

let ROOT: string

type Json = Record<string, unknown>

/**
 * The comments fixture with one behaviour more: a guest's GET of a route with no parameter and no
 * `given`, the one case whose skeleton makes its request with nothing left to fill. It is what
 * shows a test failing on the unmounted route itself, and passing once the route is mounted.
 */
function guestIndexPlan(): Json {
  const plan = loadCommentsPlan() as { controllers: Json[]; routes: Json[]; tasks: Array<{ covers: string[]; acceptance: Json[] }> }
  const controller = plan.controllers[0] as { actions: Json[] }
  controller.actions.push({ id: 'action.comments.index', change: { kind: 'add' }, name: 'index', authorization: { middleware: ['auth'] }, response: { kind: 'json', description: 'The comments.' }, rules: [] })
  plan.routes.push({ id: 'route.comments.index', change: { kind: 'add' }, method: 'GET', path: '/comments', name: 'comments.index', action: 'action.comments.index', middleware: ['auth'], bind: [] })
  plan.tasks[0]!.covers.push('route.comments.index')
  plan.tasks[0]!.acceptance.push({ id: 'AC-comments-5', description: 'A guest is sent to sign in before reading comments.', kind: 'unauthenticated', actor: 'guest', route: 'route.comments.index', given: [], expect: { redirect: '/login' } })
  return plan as unknown as Json
}

const APP_ENTRY = `import { createApp } from '@guren/core'
import { registerWebRoutes } from '../routes/web.js'

const app = createApp({
  routes: registerWebRoutes,
  providers: [],
})

export default app
`

const WEB_ROUTES = `import type { Router } from '@guren/core'

export function registerWebRoutes(router: Router): void {
  router.get('/', (c) => c.text('ok')).name('home')
}
`

function appFiles(name: string, document: Json): Record<string, string> {
  return {
    ...PLAN_APP_FILES,
    'package.json': JSON.stringify({ name, type: 'module', dependencies: { '@guren/inertia-client': '*' }, scripts: { codegen: 'exit 0' } }),
    'bunfig.toml': '[install]\nauto = "disable"\n',
    'tsconfig.json': JSON.stringify({ compilerOptions: { paths: { '@/*': ['./*'] } } }),
    'src/app.ts': APP_ENTRY,
    'routes/web.ts': WEB_ROUTES,
    [PLAN_FILE]: JSON.stringify(document),
  }
}

/** An app a real `bun test` can run: core, the ORM, drizzle, zod and the testing package resolve as an install would. */
async function createApp(name: string, options: { document?: Json; files?: Record<string, string>; link?: boolean } = {}): Promise<{ dir: string; plan: string }> {
  const dir = join(ROOT, name)
  const document = options.document ?? approvedAgainst(guestIndexPlan())
  await writeWorkspaceFiles(dir, { ...appFiles(name, document), ...options.files })
  if (options.link !== false) {
    await linkWorkspaceCore(dir)
    await linkWorkspacePackage('testing', dir)
    await symlink(WORKSPACE_DRIZZLE, join(dir, 'node_modules', 'drizzle-orm'), 'dir')
    await linkWorkspacePackage('orm', dir)
    await symlink(WORKSPACE_ZOD, join(dir, 'node_modules', 'zod'), 'dir')
  }
  const plan = join(dir, PLAN_FILE)
  if ('baseline' in document) await approvePlanFile(plan)
  return { dir, plan }
}

function mark(dir: string, step: string): Promise<string> {
  return writePlanActiveStep(dir, 'comments', { plan: PLAN_FILE, step, startedAt: '2026-09-26T00:00:00.000Z', continuations: 0 })
}

/** The scaffold step, then the tests step, each marked first as plan:next would. */
async function scaffolded(name: string, options: Parameters<typeof createApp>[1] = {}): Promise<{ dir: string; plan: string; report: PlanScaffoldReport }> {
  const app = await createApp(name, options)
  await mark(app.dir, SCAFFOLD)
  await planScaffoldFile(app.plan, { appRoot: app.dir, step: SCAFFOLD })
  await mark(app.dir, TESTS)
  const report = await planScaffoldFile(app.plan, { appRoot: app.dir, step: TESTS })
  return { ...app, report }
}

function emitted(document: Json = approvedAgainst(guestIndexPlan()), app: Partial<PlanTestsApp> = {}): ReturnType<typeof emitPlanTests> {
  const plan = parsePlanDocument(document)
  const found = findPlanStep(derivePlanTasks(plan), TESTS)!
  return emitPlanTests(plan, found.task, found.step, { slug: 'comments', planFile: PLAN_FILE }, { entry: 'src/app.ts', modelFiles: { Comment: 'app/Models/Comment.ts', Post: 'app/Models/Post.ts' }, ...app })
}

describe('plan:scaffold on a tests step', () => {
  const log = spyOn(console, 'log')

  beforeAll(async () => {
    ROOT = await createTempRoot('guren-plan-scaffold-tests-')
  })

  afterEach(() => {
    log.mockReset()
    process.exitCode = 0
  })

  async function verifyTests(plan: string, dir: string): Promise<PlanVerifyReport> {
    // A drifted tests:fail record is re-checked without a run, so each run here starts from no record.
    await rm(join(dir, '.guren/plans/comments.state.json'), { force: true })
    log.mockImplementation(() => {})
    await runCommand(builtinSubCommands['plan:verify'] as CommandDef, { rawArgs: [plan, '--app', dir, '--step', TESTS, '--json'] })
    return JSON.parse(log.mock.calls.map((call) => String(call[0])).join('\n')) as PlanVerifyReport
  }

  function testsCommand(report: PlanVerifyReport): PlanVerifyReport['steps'][number]['record']['commands'][number] {
    return report.steps[0]!.record.commands.find((command) => command.command === 'tests:fail')!
  }

  test('should write one test per behaviour, titled with its id, requesting its route and asserting what the plan expects', () => {
    const output = emitted()
    expect(output.refusals).toEqual([])
    expect(output.unwritten).toEqual([])
    expect(output.file.path).toBe(TEST_FILE)
    expect(output.file.elements).toEqual(IDS)
    expect(output.file.contents).toMatchInlineSnapshot(`
      "import { describe, expect, test } from 'bun:test'
      import { TestApp } from '@guren/testing'
      import { Comment } from '../../../app/Models/Comment.js'

      // Written by plan:scaffold from comments.plan.json (task/entity/model.comment/tests). Keep each title's id and the request
      // it makes: plan:verify finds a behaviour by its id, and each test fails until its implementation exists.
      // Setting up rows and cleaning them up is yours: a row left by another test can make a database
      // expectation pass or fail whatever the implementation does.
      let booted: Promise<TestApp> | undefined

      /** The application, booted inside a test so a boot that fails fails each test by name; primed for CSRF where it is mounted. */
      async function client(actor?: object): Promise<TestApp> {
        booted ??= import('../../../src/app.js')
          .then(({ default: app }) => TestApp.fromApp(app))
          .catch((error: unknown) => {
            throw new Error(\`Application boot failed: \${error instanceof Error ? error.message : String(error)}\`, { cause: error })
          })
        const http = actor === undefined ? await booted : (await booted).actingAs(actor)
        try {
          return await http.withCsrf()
        } catch (error) {
          // For an application with no CSRF middleware, which issues no XSRF-TOKEN; one mounting it with \`cookie: false\` is not handled.
          if (error instanceof Error && error.message.startsWith('withCsrf(): GET / did not set an XSRF-TOKEN cookie.')) return http
          throw error
        }
      }

      /** Setup the plan states in prose: replace each call with that setup, or the test fails here. */
      function given<T = void>(setup: string): T {
        throw new Error(\`Write this setup first: \${setup}\`)
      }

      describe('Comment', () => {
        test('[AC-comments-1] A signed-in user can comment on a post.', async () => {
          given('a post exists')
          const actor = given<object>('the actor: user')
          const postId = given<number | string>('the :postId parameter')
          await (await client(actor)).post(\`/posts/\${postId}/comments\`, { body: 'Nice post' }).assertStatus(302)
          expect(await Comment.where({ body: 'Nice post' }).first()).not.toBeNull()
        })

        test('[AC-comments-2] An empty comment is rejected.', async () => {
          given('a post exists')
          const actor = given<object>('the actor: user')
          const postId = given<number | string>('the :postId parameter')
          const response = await (await client(actor)).post(\`/posts/\${postId}/comments\`, { body: '' }).assertStatus(422)
          const body = await response.json<{ errors?: Record<string, unknown> }>()
          expect(Object.keys(body.errors ?? {})).toEqual(expect.arrayContaining(['body']))
        })

        test('[AC-comments-3] A guest cannot comment.', async () => {
          given('a post exists')
          const postId = given<number | string>('the :postId parameter')
          await (await client()).post(\`/posts/\${postId}/comments\`).assertRedirect('/login')
        })

        test('[AC-comments-4] A user cannot delete someone else\\'s comment.', async () => {
          given('a comment written by another user exists')
          const actor = given<object>('the actor: user')
          const id = given<number | string>('the :id parameter')
          await (await client(actor)).delete(\`/comments/\${id}\`).assertStatus(403)
        })

        test('[AC-comments-5] A guest is sent to sign in before reading comments.', async () => {
          await (await client()).get('/comments').assertRedirect('/login')
        })
      })
      "
    `)
  })

  test('should be found by plan:verify through the ids its titles carry, and by no other behaviour', async () => {
    const dir = join(ROOT, 'selection')
    await writeWorkspaceFiles(dir, { [TEST_FILE]: emitted().file.contents, 'tests/other.test.ts': "test('[AC-other-1] x', () => {})\n" })
    const files = [join(dir, TEST_FILE), join(dir, 'tests/other.test.ts')]
    expect(await acceptanceTestFiles(dir, files, IDS)).toEqual([TEST_FILE])
    for (const id of IDS) expect(await acceptanceTestFiles(dir, files, [id])).toEqual([TEST_FILE])
    expect(await acceptanceTestFiles(dir, files, ['AC-other-1'])).toEqual(['tests/other.test.ts'])
  })

  test('should spell every request so the static scan reads it back to its behaviour’s route', async () => {
    // An Inertia expectation adds `.json()` to the receiver, a builder the scan follows.
    const withPage = guestIndexPlan() as { tasks: Array<{ acceptance: Json[] }> }
    withPage.tasks[0]!.acceptance.push({ id: 'AC-comments-6', description: 'A signed-in user sees the post page.', kind: 'success', actor: 'user', route: 'route.comments.index', given: [], expect: { inertia: 'view.posts.show' } })
    const document = approvedAgainst(withPage as unknown as Json)
    expect(emitted(document).file.contents).toContain("await (await client(actor)).json().get('/comments').assertInertia('posts/Show')")
    const plan = parsePlanDocument(document)
    const dir = join(ROOT, 'requests')
    await writeWorkspaceFiles(dir, { [TEST_FILE]: emitted(document).file.contents })
    const scan = await scanTestRequests(dir, [join(dir, TEST_FILE)], new ParseCache())
    const routes = plan.routes.map((route) => ({ method: route.method, path: route.path }))
    const coverage = testCoverage(scan, routes)

    expect(scan.unresolved).toEqual([])
    expect(scan.unparsed).toEqual([])
    expect(coverage.uncertainByRoute.size).toBe(0)
    const behaviours = plan.tasks.flatMap((task) => task.acceptance)
    // Each behaviour's request reaches its own route; one request per behaviour, so the lines line up.
    const reached = [...coverage.byRoute].flatMap(([index, sites]) => sites.map((site) => [site.line, plan.routes[index]!.id] as const)).sort(([left], [right]) => left - right)
    expect(reached.map(([, route]) => route)).toEqual(behaviours.map((behaviour) => behaviour.route))
  })

  // A limit of the scan, not of the skeleton: a runtime value may fail a constraint, so it is `unknown` there.
  test('should leave a constrained parameter’s request uncertain rather than matched', async () => {
    const document = guestIndexPlan() as { routes: Array<{ id: string; path: string }> }
    document.routes.find((route) => route.id === 'route.comments.destroy')!.path = '/comments/:id{[0-9]+}'
    const approved = approvedAgainst(document as unknown as Json)
    const dir = join(ROOT, 'constrained')
    const output = emitted(approved)
    expect(output.file.contents).toContain('.delete(`/comments/${id}`)')
    await writeWorkspaceFiles(dir, { [TEST_FILE]: output.file.contents })
    const scan = await scanTestRequests(dir, [join(dir, TEST_FILE)], new ParseCache())
    const coverage = testCoverage(scan, [{ method: 'DELETE', path: '/comments/:id{[0-9]+}' }])
    expect(coverage.byRoute.size).toBe(0)
    expect(coverage.uncertainByRoute.get(0)?.map((site) => site.text)).toEqual(['DELETE /comments/${…}'])
  })

  test('should write an expectation it cannot type as a failing unwritten() call, and one a missing route would satisfy as well', () => {
    const document = guestIndexPlan() as { tasks: Array<{ acceptance: Array<{ id: string; expect: Json }> }> }
    const [first, , third, fourth] = document.tasks[0]!.acceptance
    first!.expect = { status: 302, database: [{ table: 'comments', has: [{ name: 'createdAt', json: '"2026-01-01"' }] }, { table: 'audits', missing: [{ name: 'id', json: '1' }] }] }
    third!.expect = { database: [{ table: 'comments', missing: [{ name: 'body', json: '"x"' }] }] }
    fourth!.expect = { status: 404 }
    const output = emitted(document as unknown as Json)

    expect(output.unwritten).toEqual([
      { element: 'AC-comments-1', detail: 'database comments has createdAt = "2026-01-01"', reason: '"2026-01-01" is no literal a datetime column compares with' },
      { element: 'AC-comments-1', detail: 'database audits missing id = 1', reason: 'no model of the plan declares the table audits' },
      { element: 'AC-comments-3', detail: 'expect', reason: 'nothing written here fails against a route that does not exist yet, so assert what the behaviour changes' },
      { element: 'AC-comments-4', detail: 'status 404', reason: 'a route that does not exist yet answers 404 as well, so assert what tells the two apart' },
    ])
    expect(output.file.contents).toContain('function unwritten(expectation: string): void {')
    expect(output.file.contents).toContain("    expect(await Comment.where({ body: 'x' }).first()).toBeNull()\n    unwritten('expect: nothing written here fails")
  })

  test('should leave out of the file every name its prose would carry as a behaviour id', () => {
    const document = guestIndexPlan() as { tasks: Array<{ acceptance: Array<{ description: string; given: string[] }> }> }
    document.tasks[0]!.acceptance[0]!.description = 'Like [AC-comments-2], but it saves'
    document.tasks[0]!.acceptance[0]!.given = ['a post exists, as in [AC-other-9]']
    const contents = emitted(document as unknown as Json).file.contents
    expect(contents).toContain("test('[AC-comments-1] Like (AC-comments-2), but it saves'")
    expect(contents).toContain("given('a post exists, as in (AC-other-9)')")
    expect([...contents.matchAll(/\[AC-[^\]]+\]/g)].map(([token]) => token)).toEqual(IDS.map((id) => `[${id}]`))
  })

  test('should refuse a request body or a database value carrying another behaviour’s id, which plan:verify would select the file by', () => {
    const inBody = guestIndexPlan() as { tasks: Array<{ acceptance: Array<{ input?: Json[]; expect: Json }> }> }
    inBody.tasks[0]!.acceptance[0]!.input = [{ name: 'body', json: '"see [AC-billing-1]"' }]
    expect(emitted(inBody as unknown as Json).refusals).toEqual([
      `[AC-billing-1] would be carried by ${TEST_FILE}, which is not a behaviour of this step; plan:verify needs each behaviour in one test file.`,
    ])

    const inRow = guestIndexPlan() as { tasks: Array<{ acceptance: Array<{ expect: Json }> }> }
    inRow.tasks[0]!.acceptance[0]!.expect = { status: 302, database: [{ table: 'comments', has: [{ name: 'body', json: '"[AC-comments-9]"' }] }] }
    expect(emitted(inRow as unknown as Json).refusals).toEqual([
      `[AC-comments-9] would be carried by ${TEST_FILE}, which is not a behaviour of this step; plan:verify needs each behaviour in one test file.`,
    ])
    // One of the step's own ids in a value is no refusal: the file carries it already.
    inRow.tasks[0]!.acceptance[0]!.expect = { status: 302, database: [{ table: 'comments', has: [{ name: 'body', json: '"[AC-comments-2]"' }] }] }
    expect(emitted(inRow as unknown as Json).refusals).toEqual([])
  })

  test('should list a behaviour on an existing route with nothing to set up, whose test may pass before any implementation', () => {
    const document = guestIndexPlan() as { routes: Array<{ id: string; change: Json }> }
    document.routes.find((route) => route.id === 'route.comments.index')!.change = { kind: 'existing' }
    expect(emitted(document as unknown as Json).mayPassNow).toEqual(['AC-comments-5'])
    expect(emitted().mayPassNow).toEqual([])
  })

  test('should match the exact message withCsrf() throws when no CSRF middleware issued a token', async () => {
    const source = await readFile(TESTING_SOURCE, 'utf8')
    expect(source).toContain('`withCsrf(): GET ${path} did not set an XSRF-TOKEN cookie. `')
    expect(PLAN_TESTS_CSRF_ABSENT).toBe('withCsrf(): GET / did not set an XSRF-TOKEN cookie.')
  })

  test('should write output that typechecks beside the files the scaffold step wrote', async () => {
    const { dir, report } = await scaffolded('typecheck')
    expect(report.created).toEqual([TEST_FILE])
    const files = [TEST_FILE, 'src/app.ts', 'routes/web.ts', 'db/schema.ts', 'app/Models/Comment.ts', 'app/Models/Post.ts'].map((file) => join(dir, file))
    const options = templateCompilerOptions({
      '@/*': [join(dir, '*')],
      '@guren/testing': [TESTING_TYPES],
      zod: [WORKSPACE_ZOD],
      'drizzle-orm': [WORKSPACE_DRIZZLE],
      'drizzle-orm/*': [join(WORKSPACE_DRIZZLE, '*')],
    })
    expect(checkTypes(files, { ...options, types: ['bun-types', 'node'] })).toEqual([])
  }, TSC_TIMEOUT)

  describe('through plan:verify on the scaffolded, unmounted application', () => {
    test('should verify the tests step: every case runs and fails, none skipped', async () => {
      const { dir, plan, report } = await scaffolded('verify')
      expect(report).toMatchObject({ kind: 'tests', step: TESTS, created: [TEST_FILE], emitted: IDS, unwritten: [] })

      const result = await verifyTests(plan, dir)
      const record = result.steps[0]!.record
      expect(testsCommand(result)).toMatchObject({ status: 'pass', label: `bun test ${TEST_FILE}` })
      expect(record.outcome).toBe('verified')
      expect(record.acceptance.map((behaviour) => [behaviour.id, behaviour.status])).toEqual(IDS.map((id) => [id, 'failing']))

      // Why each case failed: the guest's on the unmounted route itself, every other at a given() placeholder.
      const run = Bun.spawnSync([process.execPath, 'test', TEST_FILE], { cwd: dir, stdout: 'pipe', stderr: 'pipe' })
      const parts = run.stderr.toString().split(/^\(fail\) Comment > \[([^\]]+)\].*$/m)
      const failures = parts.flatMap((part, index) => (index % 2 === 1 ? [[part, /^error: ([^:\n]+)/m.exec(parts[index - 1]!)?.[1]]] : []))
      expect(failures).toEqual([
        ['AC-comments-1', 'Write this setup first'],
        ['AC-comments-2', 'Write this setup first'],
        ['AC-comments-3', 'Write this setup first'],
        ['AC-comments-4', 'Write this setup first'],
        ['AC-comments-5', 'Expected redirect status, got 404'],
      ])
    }, 60_000)

    test('should not verify with a case skipped, which is not a run', async () => {
      const { dir, plan } = await scaffolded('skipped')
      const file = join(dir, TEST_FILE)
      const source = await readFile(file, 'utf8')
      await writeFile(file, source.replace("  test('[AC-comments-1]", "  test.skip('[AC-comments-1]"))

      const result = await verifyTests(plan, dir)
      expect(testsCommand(result)).toMatchObject({ status: 'fail', reason: 'a behaviour is not failing' })
      expect(testsCommand(result).findings.join('\n')).toContain('[AC-comments-1] must fail before its implementation exists: skipped')
    }, 60_000)

    // Boot is shared, so every case that reaches client() fails on it while the others fail at given(): one is enough.
    test('should record blocked when the application does not boot, rather than a red run', async () => {
      const { dir, plan } = await scaffolded('boot-fails')
      await writeFile(join(dir, 'src/app.ts'), APP_ENTRY.replace('  providers: [],', "  providers: [],\n  boot: () => {\n    throw new Error('database is not configured')\n  },"))

      const result = await verifyTests(plan, dir)
      expect(testsCommand(result)).toMatchObject({ status: 'blocked', reason: 'the application did not boot, so a case failed without reaching its route' })
      expect(result.steps[0]!.record.outcome).toBe('blocked')
    }, 60_000)

    // The guest's case has nothing to fill, so once its route answers it passes, which tests:fail refuses.
    test('should not verify once the routes are mounted, since the case with no setup then passes', async () => {
      const { dir, plan } = await scaffolded('mounted')
      await mark(dir, HTTP)
      await planScaffoldMountFile(plan, { appRoot: dir, step: HTTP })

      const result = await verifyTests(plan, dir)
      expect(testsCommand(result)).toMatchObject({ status: 'fail', reason: 'a behaviour is not failing' })
      expect(testsCommand(result).findings).toEqual([expect.stringContaining('[AC-comments-5] must fail before its implementation exists: passed')])
    }, 60_000)
  })

  describe('refusals, each with nothing written', () => {
    async function refusedWithNothingWritten(name: string, setup: (app: { dir: string; plan: string }) => Promise<void>, options: Parameters<typeof createApp>[1] = {}): Promise<string> {
      const app = await createApp(name, { ...options, link: false })
      await mark(app.dir, TESTS)
      await setup(app)
      const before = await snapshotTree(app.dir)
      const message = await refusal(() => planScaffoldFile(app.plan, { appRoot: app.dir, step: TESTS }))
      expect(await snapshotTree(app.dir)).toEqual(before)
      expect(message).toEndWith('Nothing was scaffolded.')
      return message
    }

    test('should refuse a re-run, whose file exists', async () => {
      const message = await refusedWithNothingWritten('rerun', async ({ dir }) => writeWorkspaceFiles(dir, { [TEST_FILE]: '// written before\n' }))
      expect(message).toContain(`${TEST_FILE} already exists.`)
    })

    test('should refuse a behaviour another test file already carries, which plan:verify would find twice', async () => {
      const message = await refusedWithNothingWritten('carried', async ({ dir }) => writeWorkspaceFiles(dir, { 'tests/comments.test.ts': "test('[AC-comments-2] by hand', () => {})\n" }))
      expect(message).toContain('[AC-comments-2] is already carried by tests/comments.test.ts; plan:verify needs each behaviour in one test file.')
    })

    test('should refuse an entry with no default export to boot', async () => {
      const message = await refusedWithNothingWritten('no-default', async ({ dir }) => writeWorkspaceFiles(dir, { 'src/app.ts': "export const app = {}\n" }))
      expect(message).toContain('The tests boot the application src/app.ts exports by default, and src/app.ts has no default export.')
    })

    test('should refuse an unmarked step and a draft', async () => {
      const unmarked = await refusedWithNothingWritten('unmarked', async ({ dir }) => { await mark(dir, SCAFFOLD) })
      expect(unmarked).toContain(`${TESTS} is not the step plan:next marked (it marked ${SCAFFOLD}).`)
      const draft = await refusedWithNothingWritten('draft', async () => {}, { document: guestIndexPlan() })
      expect(draft).toContain('is a draft: plan:scaffold writes code from an approved plan only.')
    })
  })

  test('should write the tests step of an API-only application, which has no scaffold step', async () => {
    const { dir, plan } = await createApp('api-only', { link: false, files: { 'package.json': JSON.stringify({ name: 'api-only', type: 'module' }) } })
    await rm(join(dir, 'routes/web.ts'))
    await writeWorkspaceFiles(dir, { 'routes/api.ts': WEB_ROUTES.replace('registerWebRoutes', 'registerApiRoutes'), 'src/app.ts': APP_ENTRY.replace('../routes/web.js', '../routes/api.js').replaceAll('registerWebRoutes', 'registerApiRoutes') })
    await mark(dir, TESTS)

    const report = await planScaffoldFile(plan, { appRoot: dir, step: TESTS })
    expect(report.created).toEqual([TEST_FILE])
    // No Comment model exists without the scaffold step, so the row it would read is left to write.
    expect(report.unwritten).toEqual([{ element: 'AC-comments-1', detail: 'database comments has body = "Nice post"', reason: 'the application root declares no Comment model yet' }])
    await mark(dir, SCAFFOLD)
    expect(await refusal(() => planScaffoldFile(plan, { appRoot: dir, step: SCAFFOLD }))).toContain('This application is API-only')
  })

  test('should report what it wrote, what is left, and the verify run next', async () => {
    const { report } = await scaffolded('report', { link: false })
    expect(Object.keys(report).sort()).toEqual(['created', 'emitted', 'kind', 'mayPassNow', 'plan', 'reportVersion', 'step', 'unwritten'])
    const text = formatPlanScaffold(report, PLAN_FILE)
    expect(text).toContain(`Created:\n  ${TEST_FILE}`)
    expect(text).toContain(`One test per behaviour: ${IDS.map((id) => `[${id}]`).join(', ')}`)
    expect(text).toContain(`Next: bunx guren plan:verify ${PLAN_FILE} --step ${TESTS}, and commit once it is verified.`)
    expect(text).not.toContain('Expectations written as an unwritten() call')
  }, 30_000)
})
