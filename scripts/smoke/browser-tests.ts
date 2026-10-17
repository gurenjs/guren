/**
 * The measuring run behind RFC 0033 M4. Builds a golden-path-shaped app (auth and a posts
 * resource on SQLite) with one approved plan, runs `guren add browser-tests`, then runs
 * `test:browser` from a cold start `GUREN_BROWSER_STARTS` times, as a gate would run it once.
 * Writes `metrics.json` and each start's Playwright report into `GUREN_BROWSER_OUT`, rewriting the
 * metrics after every start. `--aggregate <dir>` reads the metrics of earlier nights instead and
 * reports the streak of clean nights the proposed rule counts. Exits 1 when nothing was measured.
 */
import { appendFile, mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { cpus, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'

import type { z } from 'zod'

import type { PlanDraftSchema } from '../../packages/cli/src/plan/schema'
import { PLAN_VERSION } from '../../packages/cli/src/plan/version'
import { inheritedEnv } from './inherited-env'
import { assertSingleInstalledCopies, ensureBuiltPackages, rewriteAppDependencies, vendorLocalPackages } from './local-packages'

const repoRoot = resolve(import.meta.dir, '../..')
const CLI = join(repoRoot, 'packages/cli/src/bin.ts')
const CREATE_APP = join(repoRoot, 'packages/create-app/src/cli.ts')
const PLAN_FILE = 'docs/plans/browser-measure/plan.json'
/** A start takes about 6 s on the CI runner; the cap keeps a dispatched run inside the workflow's timeout. */
const MAX_STARTS = 60
const DEFAULT_STARTS = 40
/** Below about 30 trials the rule of three (failure rate under 3/n at 95%) is too loose to quote. */
const RULE_OF_THREE_MIN = 30
/** CI runs on main failing with no code at fault (infra, flaky tests), 2026-07-24 to 10-16: RFC 0033 §9. */
const CI_SPURIOUS_RATE = 0.018
/** The rule's cost ceiling for one start, in ms. */
const MAX_START_MS = 120_000

function startCount(): number {
  const raw = process.env.GUREN_BROWSER_STARTS
  if (raw === undefined || raw === '') return DEFAULT_STARTS
  if (!/^\d+$/u.test(raw) || Number(raw) < 1 || Number(raw) > MAX_STARTS) {
    throw new Error(`GUREN_BROWSER_STARTS must be a whole number from 1 to ${MAX_STARTS}, got ${raw}.`)
  }
  return Number(raw)
}

// The CLI runs from this checkout's source while the app installs its own @guren/orm.
const appEnv = (): Record<string, string | undefined> => ({ ...inheritedEnv(), GUREN_QUIET_DUPLICATE_ORM: '1' })

async function run(cwd: string, command: string[], env: Record<string, string | undefined> = {}): Promise<number> {
  const child = Bun.spawn(command, { cwd, env: { ...appEnv(), ...env }, stdout: 'inherit', stderr: 'inherit' })
  return child.exited
}

async function mustRun(cwd: string, command: string[], env?: Record<string, string | undefined>): Promise<void> {
  const code = await run(cwd, command, env)
  if (code !== 0) throw new Error(`${command.join(' ')} exited ${code} in ${cwd}`)
}

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

type PlanInput = z.input<typeof PlanDraftSchema>
type ActionInput = NonNullable<PlanInput['controllers']>[number]['actions'][number]

/**
 * Every element `existing`: the plan describes what `add resource posts` wrote, so it approves
 * against the app as it stands. A field's label is its name, which is what the scaffold writes.
 */
function measurementPlan(): PlanInput {
  const existing = { kind: 'existing' } as const
  const action = (name: string, response: ActionInput['response'], extra: Partial<ActionInput> = {}): ActionInput => ({
    id: `action.post.${name}`, change: existing, name, authorization: { middleware: [] }, response, rules: [], ...extra,
  })
  const route = (name: string, method: 'GET' | 'POST', path: string, middleware: string[] = []) => ({
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

type ResultStatus = 'passed' | 'failed' | 'timedOut' | 'skipped' | 'interrupted'
interface JsonResult { status: ResultStatus; duration: number; error?: { message?: string } }
interface JsonTest { projectName: string; expectedStatus: ResultStatus; results: JsonResult[] }
interface JsonSpec { title: string; file: string; tests: JsonTest[] }
interface JsonSuite { specs?: JsonSpec[]; suites?: JsonSuite[] }
interface JsonReport { suites?: JsonSuite[]; errors?: Array<{ message?: string }>; stats?: { duration: number } }

function specsOf(suites: readonly JsonSuite[] = []): JsonSpec[] {
  return suites.flatMap((suite) => [...(suite.specs ?? []), ...specsOf(suite.suites)])
}

const firstLine = (message: string | undefined): string => (message ?? '').replace(/\u001b\[[0-9;]*m/gu, '').trim().split('\n')[0] ?? ''

interface Tally {
  /** Results that ran and were judged against the test's expected status. */
  runs: number
  failures: number
  /** Cut short by the run ending (the app died, a timeout): not the test's verdict. */
  interrupted: number
  /** Starts in which a test that should run never did, for a failed dependency such as the sign-in. */
  notRun: number
  fixme: number
  errors: string[]
}

type Verdict = 'defect' | 'flaky' | 'not-run' | 'fixme' | 'pass'

function verdictOf(tally: Tally): Verdict {
  if (tally.runs > 0 && tally.failures === tally.runs) return 'defect'
  if (tally.failures > 0) return 'flaky'
  if (tally.notRun > 0) return 'not-run'
  return tally.runs === 0 && tally.fixme > 0 ? 'fixme' : 'pass'
}

function tallyReport(tallies: Map<string, Tally>, report: JsonReport): void {
  for (const spec of specsOf(report.suites)) {
    for (const test of spec.tests) {
      const key = `${test.projectName} › ${spec.file} › ${spec.title}`
      const tally = tallies.get(key) ?? { runs: 0, failures: 0, interrupted: 0, notRun: 0, fixme: 0, errors: [] }
      tallies.set(key, tally)
      if (test.results.length === 0) {
        if (test.expectedStatus === 'skipped') tally.fixme += 1
        else tally.notRun += 1
        continue
      }
      for (const result of test.results) {
        if (result.status === 'interrupted') tally.interrupted += 1
        else if (result.status === 'skipped' && test.expectedStatus === 'skipped') tally.fixme += 1
        else {
          tally.runs += 1
          if (result.status !== test.expectedStatus) {
            tally.failures += 1
            if (tally.errors.length < 3) tally.errors.push(firstLine(result.error?.message))
          }
        }
      }
    }
  }
}

interface StartRecord {
  start: number
  exitCode: number
  wallMs: number
  /** The tests' own time; the rest of `wallMs` is the app starting and the browser launching. */
  testMs: number
  reported: boolean
  errors: string[]
}

interface Metrics {
  measuredAt: string
  commit: string | null
  runner: { os: string; image: string | null; cpus: number; bun: string; playwright: string | null }
  starts: StartRecord[]
  phases: Array<{ phase: string; ms: number }>
  tests: Array<{ test: string; verdict: Verdict } & Tally>
  summary: { startupFailures: number; flaky: number; notRun: number; defects: number; clean: boolean }
}

function summarize(tallies: Map<string, Tally>, starts: readonly StartRecord[]): Pick<Metrics, 'tests' | 'summary'> {
  const tests = [...tallies].map(([test, tally]) => ({ test, verdict: verdictOf(tally), ...tally })).sort((a, b) => a.test.localeCompare(b.test))
  const count = (verdict: Verdict): number => tests.filter((entry) => entry.verdict === verdict).length
  const summary = { startupFailures: starts.filter((entry) => !entry.reported).length, flaky: count('flaky'), notRun: count('not-run'), defects: count('defect') }
  // A defect fails every run the same way, so it says nothing about how reliable a gate would be.
  return { tests, summary: { ...summary, clean: summary.startupFailures === 0 && summary.flaky === 0 && summary.notRun === 0 } }
}

function summaryLines(metrics: Metrics): string[] {
  const { summary } = metrics
  const costs = metrics.starts.filter((entry) => entry.reported).map((entry) => entry.wallMs)
  return [
    '## Browser specs measurement (RFC 0033 M4)',
    '',
    `${metrics.starts.length} cold start(s), no retries, Playwright ${metrics.runner.playwright ?? 'unknown'}. ${summary.clean ? 'Clean' : 'Not clean'}: start-up failures ${summary.startupFailures}, flaky ${summary.flaky}, not run ${summary.notRun}; defects ${summary.defects}.`,
    costs.length > 0 ? `One start: ${(Math.min(...costs) / 1000).toFixed(1)}-${(Math.max(...costs) / 1000).toFixed(1)} s.` : 'No start produced a report.',
    '',
    '| Phase | Seconds |', '| --- | --- |',
    ...metrics.phases.map((entry) => `| ${entry.phase} | ${(entry.ms / 1000).toFixed(1)} |`),
    '',
    '| Test | Runs | Failures | Not run | Verdict | First error |', '| --- | --- | --- | --- | --- | --- |',
    ...metrics.tests.map((entry) => `| ${entry.test.replaceAll('|', '\\|')} | ${entry.runs} | ${entry.failures} | ${entry.notRun} | ${entry.verdict} | ${(entry.errors[0] ?? '').replaceAll('|', '\\|')} |`),
  ]
}

async function writeSummary(lines: readonly string[]): Promise<void> {
  console.log(`\n${lines.join('\n')}`)
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`)
}

async function measure(): Promise<void> {
  const starts = startCount()
  const root = await mkdtemp(join(tmpdir(), 'guren-browser-measure-'))
  const app = join(root, 'app')
  const out = resolve(process.env.GUREN_BROWSER_OUT || join(root, 'out'))
  await mkdir(out, { recursive: true })
  console.log(`App: ${app}\nOutput: ${out}`)

  await timed('scaffold', async () => {
    await ensureBuiltPackages()
    await mustRun(repoRoot, ['bun', CREATE_APP, app, '--mode', 'ssr', '--db', 'sqlite'])
    await rewriteAppDependencies(app, await vendorLocalPackages(join(app, '.guren-vendor')), 'The browser measurement app')
    await mustRun(app, ['bun', 'install'])
    await assertSingleInstalledCopies(app)
    for (const command of [['add', 'auth'], ['add', 'resource', 'posts'], ['codegen', '--force'], ['make:migration'], ['db:migrate']]) {
      await mustRun(app, ['bun', CLI, ...command])
    }
  })

  await timed('approve the plan', async () => {
    await mkdir(dirname(join(app, PLAN_FILE)), { recursive: true })
    await writeFile(join(app, PLAN_FILE), `${JSON.stringify(measurementPlan(), null, 2)}\n`)
    await appendFile(join(app, '.gitignore'), '\n.guren-vendor/\n')
    const git = ['git', '-c', 'user.name=Smoke', '-c', 'user.email=smoke@example.test', '-c', 'commit.gpgsign=false']
    for (const command of [['git', 'init', '-q'], ['git', 'add', '-A'], [...git, 'commit', '-q', '--no-verify', '-m', 'scaffold']]) {
      await mustRun(app, command)
    }
    await mustRun(app, ['bun', CLI, 'plan:approve', PLAN_FILE])
  })

  await timed('add browser-tests', async () => {
    await mustRun(app, ['bun', CLI, 'add', 'browser-tests'])
    // The config starts the app with `bunx guren`; without the app's own bin that is npm's placeholder.
    if (!(await Bun.file(join(app, 'node_modules/.bin/guren')).exists())) throw new Error('The app has no node_modules/.bin/guren, so the generated config cannot start it.')
    const env = await readFile(join(app, '.env'), 'utf8')
    const seeded = env.replace(/^BROWSER_TEST_PASSWORD=.*$/mu, `BROWSER_TEST_PASSWORD=${randomBytes(18).toString('base64url')}`)
    if (seeded === env) throw new Error('.env has no BROWSER_TEST_PASSWORD line to set, so the setup project could not sign in.')
    await writeFile(join(app, '.env'), seeded)
  })

  // The system libraries come with the browser on a CI runner, inside this timed phase.
  await timed('install chromium', () => mustRun(app, ['bun', 'x', 'playwright', 'install', ...(process.env.CI ? ['--with-deps'] : []), 'chromium']))

  const playwright = await Bun.file(join(app, 'node_modules/@playwright/test/package.json')).json().then((manifest: { version?: string }) => manifest.version ?? null, () => null)
  const metrics: Metrics = {
    measuredAt: new Date().toISOString(),
    commit: process.env.GITHUB_SHA ?? null,
    runner: { os: process.platform, image: process.env.ImageOS ? `${process.env.ImageOS} ${process.env.ImageVersion ?? ''}`.trim() : null, cpus: cpus().length, bun: Bun.version, playwright },
    starts: [],
    phases,
    tests: [],
    summary: { startupFailures: 0, flaky: 0, notRun: 0, defects: 0, clean: false },
  }
  const tallies = new Map<string, Tally>()
  for (let start = 1; start <= starts; start += 1) {
    const reportPath = join(out, `report-${start}.json`)
    const began = performance.now()
    const exitCode = await run(app, ['bun', 'run', 'test:browser', '--', '--retries=0', '--reporter=list,json'], { PLAYWRIGHT_JSON_OUTPUT_FILE: reportPath })
    const wallMs = Math.round(performance.now() - began)
    const report = await readFile(reportPath, 'utf8').then((text) => JSON.parse(text) as JsonReport, () => undefined)
    const results = specsOf(report?.suites).flatMap((spec) => spec.tests.flatMap((test) => test.results))
    metrics.starts.push({
      start, exitCode, wallMs,
      testMs: results.reduce((total, result) => total + result.duration, 0),
      reported: results.length > 0,
      errors: (report?.errors ?? []).map((error) => firstLine(error.message)),
    })
    if (report) tallyReport(tallies, report)
    Object.assign(metrics, summarize(tallies, metrics.starts))
    await writeFile(join(out, 'metrics.json'), `${JSON.stringify(metrics, null, 2)}\n`)
  }

  await writeSummary(summaryLines(metrics))
  console.log(`\nMetrics: ${join(out, 'metrics.json')}\nApp kept at ${app}`)
  if (metrics.summary.startupFailures === starts) throw new Error('No start produced a report: the app never came up under test:browser.')
}

/** The nights the proposed rule reads, newest first: each night's metrics.json under `dir`, at any depth. */
async function aggregate(dir: string): Promise<void> {
  const files = (await readdir(dir, { recursive: true })).filter((file) => file.endsWith('metrics.json'))
  const nights = (await Promise.all(files.map(async (file) => JSON.parse(await readFile(join(dir, file), 'utf8')) as Metrics)))
    .sort((a, b) => b.measuredAt.localeCompare(a.measuredAt))
  if (nights.length === 0) throw new Error(`No metrics.json under ${dir}.`)
  const streak = nights.findIndex((night) => !night.summary.clean)
  const cleanNights = streak === -1 ? nights.length : streak
  const starts = nights.flatMap((night) => night.starts.filter((entry) => entry.reported).map((entry) => entry.wallMs)).sort((a, b) => a - b)
  const failingTests = new Map<string, { nights: number; verdicts: Set<Verdict> }>()
  for (const night of nights) {
    for (const test of night.tests.filter((entry) => entry.verdict !== 'pass' && entry.verdict !== 'fixme')) {
      const seen = failingTests.get(test.test) ?? { nights: 0, verdicts: new Set<Verdict>() }
      seen.nights += 1
      seen.verdicts.add(test.verdict)
      failingTests.set(test.test, seen)
    }
  }
  const coldStarts = nights.slice(0, cleanNights).reduce((total, night) => total + night.starts.length, 0)
  const needed = Math.ceil(3 / CI_SPURIOUS_RATE)
  await writeSummary([
    '## Browser specs measurement across nights (RFC 0033 M4)',
    '',
    `${nights.length} night(s) read. The latest ${cleanNights} in a row are clean (${coldStarts} cold starts with no start-up failure, flake or test left unrun${coldStarts >= RULE_OF_THREE_MIN ? `; by the rule of three a failure rate under ${(300 / coldStarts).toFixed(1)}% at 95% confidence` : ''}).`,
    starts.length > 0 ? `One start, median ${(starts[Math.floor(starts.length / 2)]! / 1000).toFixed(1)} s, slowest ${(starts.at(-1)! / 1000).toFixed(1)} s.` : '',
    `The rule (RFC 0033 §9, adopted provisionally) needs ${needed} clean cold starts in a row, which bounds the rate under the CI baseline of ${(CI_SPURIOUS_RATE * 100).toFixed(1)}%, and every start under ${MAX_START_MS / 1000} s: ${coldStarts >= needed && (starts.at(-1) ?? 0) < MAX_START_MS ? 'met' : 'not met yet'}.`,
    '',
    '| Test | Nights not passing | Verdicts |', '| --- | --- | --- |',
    ...[...failingTests].map(([test, seen]) => `| ${test.replaceAll('|', '\\|')} | ${seen.nights} | ${[...seen.verdicts].join(', ')} |`),
  ])
}

const [flag, dir] = process.argv.slice(2)
if (flag === '--aggregate') {
  if (!dir) throw new Error('Usage: browser-tests.ts --aggregate <directory of metrics.json files>')
  await aggregate(resolve(dir))
} else {
  await measure()
}
