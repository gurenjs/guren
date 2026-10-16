/**
 * The measuring run behind RFC 0033 M4: the golden-path app (auth and a posts resource) with one
 * approved plan, `guren add browser-tests`, then `test:browser` started `GUREN_BROWSER_STARTS`
 * times, each with `--repeat-each=GUREN_BROWSER_REPEAT_EACH` and no retries. A test failing every
 * time is a defect, one failing some of the time a flake; a start that produced no report is a
 * start-up failure. Writes the metrics as JSON (`GUREN_BROWSER_METRICS`) and a step summary.
 * Exits 1 only when the instrument itself broke: a gate decision reads the data, not this exit code.
 */
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'

import { PLAN_VERSION } from '../../packages/cli/src/plan/version'
import { inheritedEnv } from './inherited-env'
import { assertSingleInstalledCopies, ensureBuiltPackages, rewriteAppDependencies, vendorLocalPackages } from './local-packages'

const repoRoot = resolve(import.meta.dir, '../..')
const CLI = join(repoRoot, 'packages/cli/src/bin.ts')
const CREATE_APP = join(repoRoot, 'packages/create-app/src/cli.ts')
const PLAN_FILE = 'docs/plans/browser-measure/plan.json'

function positiveInteger(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer, got ${raw}.`)
  return value
}

const STARTS = positiveInteger('GUREN_BROWSER_STARTS', 3)
const REPEAT_EACH = positiveInteger('GUREN_BROWSER_REPEAT_EACH', 3)

const phases: Array<{ phase: string; ms: number }> = []

async function timed<T>(phase: string, work: () => Promise<T>): Promise<T> {
  const started = performance.now()
  console.log(`\n== ${phase}`)
  try {
    return await work()
  } finally {
    phases.push({ phase, ms: Math.round(performance.now() - started) })
  }
}

async function run(cwd: string, command: string[], env: Record<string, string | undefined> = inheritedEnv()): Promise<number> {
  const child = Bun.spawn(command, { cwd, env, stdout: 'inherit', stderr: 'inherit' })
  return child.exited
}

async function mustRun(cwd: string, command: string[], env?: Record<string, string | undefined>): Promise<void> {
  const code = await run(cwd, command, env)
  if (code !== 0) throw new Error(`${command.join(' ')} exited ${code} in ${cwd}`)
}

/**
 * Every element `existing`: the plan describes what `add resource posts` wrote, so it approves
 * against the app as it stands. The New page's fields name their field as the label, since the
 * scaffold labels nothing; a spec that cannot find them is the defect this run reports.
 */
function measurementPlan(): Record<string, unknown> {
  const existing = { kind: 'existing' }
  const action = (name: string, response: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    id: `action.post.${name}`, change: existing, name, authorization: { middleware: [] }, response, rules: [], ...extra,
  })
  const route = (name: string, method: string, path: string, middleware: string[] = []) => ({
    id: `route.posts.${name}`, change: existing, method, path, name: `posts.${name}`, action: `action.post.${name}`, middleware, bind: [],
  })
  return {
    planVersion: PLAN_VERSION,
    title: 'Browser measurement',
    summary: 'Describes the posts pages so the browser specs check their locators.',
    scope: { goals: ['Measure the generated browser specs'], nonGoals: [] },
    locale: 'en',
    validators: [{ id: 'validator.post', change: existing, name: 'PostPayloadSchema', fields: [{ name: 'title', type: 'string', required: true, rules: [] }] }],
    controllers: [{
      id: 'controller.post', change: existing, className: 'PostController', actions: [
        action('index', { kind: 'inertia', view: 'view.posts.index' }),
        action('create', { kind: 'inertia', view: 'view.posts.new' }),
        action('store', { kind: 'redirect', to: '/posts' }, { body: 'validator.post', authorization: { middleware: ['auth'] } }),
      ],
    }],
    routes: [route('index', 'GET', '/posts'), route('create', 'GET', '/posts/create'), route('store', 'POST', '/posts', ['auth'])],
    views: [
      {
        id: 'view.posts.index', change: existing, page: 'posts/Index', purpose: 'Lists the posts.', props: [],
        actions: [{ label: 'New Post', route: 'route.posts.create' }], states: {},
      },
      {
        id: 'view.posts.new', change: existing, page: 'posts/New', purpose: 'Writes a post.', props: [],
        form: { validator: 'validator.post', submitsTo: 'route.posts.store', fields: [{ field: 'title', label: 'title', input: 'text' }] },
        actions: [{ label: 'Create', route: 'route.posts.store' }], states: {},
      },
    ],
  }
}

interface JsonTestResult { status: string; duration: number }
interface JsonTest { projectName: string; results: JsonTestResult[] }
interface JsonSpec { title: string; file: string; tests: JsonTest[] }
interface JsonSuite { specs?: JsonSpec[]; suites?: JsonSuite[] }
interface JsonReport { suites?: JsonSuite[]; errors?: unknown[]; stats?: { duration: number } }

function specsOf(suites: readonly JsonSuite[] = []): JsonSpec[] {
  return suites.flatMap((suite) => [...(suite.specs ?? []), ...specsOf(suite.suites)])
}

interface TestTally { runs: number; failures: number; skipped: number; durationsMs: number[] }

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'guren-browser-measure-'))
  const app = join(root, 'app')
  const metricsPath = process.env.GUREN_BROWSER_METRICS || join(root, 'browser-metrics.json')
  console.log(`App: ${app}`)

  await timed('scaffold', async () => {
    await ensureBuiltPackages()
    await mustRun(repoRoot, ['bun', CREATE_APP, app, '--mode', 'ssr', '--db', 'sqlite'])
    const tarballs = await vendorLocalPackages(join(app, '.guren-vendor'))
    await rewriteAppDependencies(app, tarballs)
    await mustRun(app, ['bun', 'install'])
    await assertSingleInstalledCopies(app)
    await mustRun(app, ['bun', CLI, 'add', 'auth'])
    await mustRun(app, ['bun', CLI, 'add', 'resource', 'posts'])
    await mustRun(app, ['bun', CLI, 'codegen', '--force'])
    await mustRun(app, ['bun', CLI, 'make:migration'])
    await mustRun(app, ['bun', CLI, 'db:migrate'])
  })

  await timed('approve the plan', async () => {
    await mkdir(join(app, 'docs/plans/browser-measure'), { recursive: true })
    await writeFile(join(app, PLAN_FILE), `${JSON.stringify(measurementPlan(), null, 2)}\n`)
    for (const command of [['git', 'init', '-q'], ['git', 'add', '-A'], ['git', '-c', 'user.name=Smoke', '-c', 'user.email=smoke@example.test', 'commit', '-qm', 'scaffold']]) {
      await mustRun(app, command)
    }
    await mustRun(app, ['bun', CLI, 'plan:approve', PLAN_FILE])
  })

  await timed('add browser-tests', async () => {
    await mustRun(app, ['bun', CLI, 'add', 'browser-tests'])
    // The config starts the app with `bunx guren`; without the app's own bin that is npm's placeholder.
    if (!(await Bun.file(join(app, 'node_modules/.bin/guren')).exists())) throw new Error('The app has no node_modules/.bin/guren, so the generated config cannot start it.')
    const env = await readFile(join(app, '.env'), 'utf8')
    await writeFile(join(app, '.env'), env.replace(/^BROWSER_TEST_PASSWORD=.*$/mu, `BROWSER_TEST_PASSWORD=${randomBytes(18).toString('base64url')}`))
  })

  await timed('install chromium', () => mustRun(app, ['bun', 'x', 'playwright', 'install', 'chromium']))

  const tallies = new Map<string, TestTally>()
  const starts: Array<{ start: number; exitCode: number; wallMs: number; reported: boolean; startupErrors: number }> = []
  for (let start = 1; start <= STARTS; start += 1) {
    const reportPath = join(root, `report-${start}.json`)
    const began = performance.now()
    const exitCode = await run(app, ['bun', 'run', 'test:browser', '--', '--retries=0', `--repeat-each=${REPEAT_EACH}`, '--reporter=json'], {
      ...inheritedEnv(), PLAYWRIGHT_JSON_OUTPUT_FILE: reportPath,
    })
    const wallMs = Math.round(performance.now() - began)
    phases.push({ phase: `test:browser start ${start}`, ms: wallMs })
    let report: JsonReport | undefined
    try {
      report = JSON.parse(await readFile(reportPath, 'utf8')) as JsonReport
    } catch {
      report = undefined
    }
    const specs = specsOf(report?.suites)
    starts.push({ start, exitCode, wallMs, reported: specs.length > 0, startupErrors: report?.errors?.length ?? 0 })
    for (const spec of specs) {
      for (const test of spec.tests) {
        const key = `${test.projectName} › ${spec.file} › ${spec.title}`
        const tally = tallies.get(key) ?? { runs: 0, failures: 0, skipped: 0, durationsMs: [] }
        for (const result of test.results) {
          if (result.status === 'skipped') {
            tally.skipped += 1
            continue
          }
          tally.runs += 1
          if (result.status !== 'passed') tally.failures += 1
          tally.durationsMs.push(result.duration)
        }
        tallies.set(key, tally)
      }
    }
  }

  const tests = [...tallies].map(([test, tally]) => ({
    test, ...tally,
    verdict: tally.runs === 0 ? 'skipped' : tally.failures === 0 ? 'pass' : tally.failures === tally.runs ? 'defect' : 'flaky',
  }))
  const metrics = {
    measuredAt: new Date().toISOString(),
    commit: process.env.GITHUB_SHA ?? null,
    runner: { os: process.platform, bun: Bun.version },
    settings: { starts: STARTS, repeatEach: REPEAT_EACH, retries: 0 },
    phases,
    starts,
    tests,
    summary: {
      startupFailures: starts.filter((entry) => !entry.reported).length,
      flaky: tests.filter((entry) => entry.verdict === 'flaky').length,
      defects: tests.filter((entry) => entry.verdict === 'defect').length,
    },
  }
  await writeFile(metricsPath, `${JSON.stringify(metrics, null, 2)}\n`)

  const lines = [
    '## Browser specs measurement (RFC 0033 M4)',
    '',
    `${STARTS} start(s) × repeat-each ${REPEAT_EACH}, no retries. Start-up failures: ${metrics.summary.startupFailures}, flaky tests: ${metrics.summary.flaky}, defects: ${metrics.summary.defects}.`,
    '',
    '| Phase | Seconds |', '| --- | --- |',
    ...phases.map((entry) => `| ${entry.phase} | ${(entry.ms / 1000).toFixed(1)} |`),
    '',
    '| Test | Runs | Failures | Verdict |', '| --- | --- | --- | --- |',
    ...tests.map((entry) => `| ${entry.test.replaceAll('|', '\\|')} | ${entry.runs} | ${entry.failures} | ${entry.verdict} |`),
  ]
  console.log(`\n${lines.join('\n')}\n\nMetrics: ${metricsPath}`)
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`)

  // The default metrics file sits in the work directory, which is kept for it.
  if (process.env.GUREN_BROWSER_METRICS && process.env.GUREN_KEEP_SMOKE_DIR !== '1') await rm(root, { recursive: true, force: true })
  else console.log(`Kept ${root}`)
  if (starts.every((entry) => !entry.reported)) {
    throw new Error('No start produced a Playwright report, so nothing was measured.')
  }
}

await main()
