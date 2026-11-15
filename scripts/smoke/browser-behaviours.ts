/**
 * The nightly replay of RFC 0033 §13 (Open Question 13): the measurement app with the behaviours plan,
 * set up by `guren add browser-tests --behaviours`, replays the recordings committed under
 * FIXTURE_DIR `GUREN_BEHAVIOURS_REPLAYS` times, each against a database migrated from empty and with
 * every agent login hidden, and writes `behaviours.json` into `GUREN_BROWSER_OUT`. A recording that no
 * longer matches (`stale`) or is gone (`missing`) is what a Guren change does to an app's recordings,
 * counted apart from the replay streak. `--record` makes the recordings under a Claude Code login,
 * proves they replay, and replaces the fixture whole. `--aggregate <dir>` reads earlier nights.
 */
import { randomBytes } from 'node:crypto'
import { appendFile, cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { cpus, homedir, hostname, tmpdir, userInfo } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'

import { BEHAVIOUR_AGENTS, BEHAVIOUR_DEV_PACKAGES } from '../../packages/cli/src/add-browser-tests'
import { BEHAVIOURS_GIVEN_FILE, GENERATED_BEHAVIOURS_DIR } from '../../packages/cli/src/browser-behaviour-specs'
import { cliDependencyRange } from '../../packages/cli/src/cli-manifest'
import { approveMeasurementPlan, CLI, measurementPlan, mustRun, repoRoot, run, scaffoldMeasurementApp, type PlanInput } from './browser-measure-app'

const FIXTURE_DIR = join(repoRoot, 'scripts/smoke/fixtures/browser-behaviours/cache')
/** The tests the fixture's recordings replayed when `--record` wrote them: a night must run each of them. */
const MANIFEST_FILE = join(repoRoot, 'scripts/smoke/fixtures/browser-behaviours/tests.json')
const DEFAULT_REPLAYS = 30
const MAX_REPLAYS = 60
/** Below about 30 trials the rule of three (failure rate under 3/n at 95%) is too loose to quote. */
const RULE_OF_THREE_MIN = 30
const DATABASE_FILES = ['data/guren.db', 'data/guren.db-wal', 'data/guren.db-shm']

function replayCount(): number {
  const raw = process.env.GUREN_BEHAVIOURS_REPLAYS
  if (raw === undefined || raw === '') return DEFAULT_REPLAYS
  if (!/^\d+$/u.test(raw) || Number(raw) < 1 || Number(raw) > MAX_REPLAYS) {
    throw new Error(`GUREN_BEHAVIOURS_REPLAYS must be a whole number from 1 to ${MAX_REPLAYS}, got ${raw}.`)
  }
  return Number(raw)
}

/** The measurement plan with the rest of the posts resource and eight behaviours, of every kind the generator skips or writes. */
function behaviourPlan(): PlanInput {
  const plan = measurementPlan()
  const existing = { kind: 'existing' } as const
  const action = (name: string, response: { kind: 'inertia'; view: string } | { kind: 'redirect'; to: string }, body?: string) => ({
    id: `action.post.${name}`, change: existing, name, authorization: { middleware: [] }, response, rules: [], ...(body ? { body } : {}),
  })
  const route = (name: string, method: 'GET' | 'PUT' | 'DELETE', path: string) => ({
    id: `route.posts.${name}`, change: existing, method, path, name: `posts.${name}`, action: `action.post.${name}`, middleware: [], bind: [],
  })
  const titleField = { field: 'title', label: 'Title', input: 'text' } as const
  const behaviour = (id: string, description: string, kind: 'success' | 'validation' | 'unauthenticated', to: string, expect: Record<string, unknown>, input?: Record<string, unknown>, given: string[] = []) => ({
    id, description, kind, actor: 'a signed-in user', route: `route.posts.${to}`, given, alreadyHolds: true,
    ...(input ? { input: Object.entries(input).map(([name, value]) => ({ name, json: JSON.stringify(value) })) } : {}),
    expect,
  })
  return {
    ...plan,
    title: 'Browser measurement',
    controllers: plan.controllers!.map((controller) => ({
      ...controller,
      actions: [
        ...controller.actions,
        action('show', { kind: 'inertia', view: 'view.posts.show' }),
        action('edit', { kind: 'inertia', view: 'view.posts.edit' }),
        action('update', { kind: 'redirect', to: '/posts/:id' }, 'validator.post'),
        action('destroy', { kind: 'redirect', to: '/posts' }),
      ],
    })),
    routes: [...plan.routes!, route('show', 'GET', '/posts/:id'), route('edit', 'GET', '/posts/:id/edit'), route('update', 'PUT', '/posts/:id'), route('destroy', 'DELETE', '/posts/:id')],
    views: [
      ...plan.views!,
      {
        id: 'view.posts.show', change: existing, page: 'posts/Show', purpose: 'Shows a post.', props: [],
        actions: [{ label: 'Edit', route: 'route.posts.edit' }, { label: 'Delete', route: 'route.posts.destroy' }], states: {},
      },
      {
        id: 'view.posts.edit', change: existing, page: 'posts/Edit', purpose: 'Edits a post.', props: [],
        form: { validator: 'validator.post', submitsTo: 'route.posts.update', fields: [titleField] },
        actions: [{ label: 'Save', route: 'route.posts.update' }], states: {},
      },
    ],
    tasks: [{
      id: 'task.posts', entity: 'Post', summary: 'The posts pages as they stand.', covers: [],
      acceptance: [
        behaviour('AC-posts-store-1', 'a signed-in user creates a post', 'success', 'store', { redirect: '/posts/:id', inertia: 'view.posts.show' }, { title: 'Measured post' }),
        behaviour('AC-posts-store-2', 'a title of spaces is refused', 'validation', 'store', { status: 422, errors: ['title'] }, { title: '   ' }),
        behaviour('AC-posts-store-3', 'an empty title is refused', 'validation', 'store', { status: 422, errors: ['title'] }, { title: '' }),
        behaviour('AC-posts-store-4', 'a guest is sent to sign in', 'unauthenticated', 'store', { status: 401 }, { title: 'x' }),
        behaviour('AC-posts-update-1', 'a signed-in user retitles a post', 'success', 'update', { redirect: '/posts/:id', inertia: 'view.posts.show' }, { title: 'Retitled post' }, ['a post exists']),
        behaviour('AC-posts-destroy-1', 'a signed-in user deletes a post', 'success', 'destroy', { redirect: '/posts', inertia: 'view.posts.index' }, undefined, ['a post exists']),
        behaviour('AC-posts-index-1', 'anyone lists the posts', 'success', 'index', { status: 200, inertia: 'view.posts.index' }),
        behaviour('AC-posts-store-5', 'a created post is stored', 'success', 'store', { status: 302, database: [{ table: 'posts', has: [{ name: 'title', json: '"Stored"' }] }] }, { title: 'Stored' }),
      ],
    }],
  } as PlanInput
}

/** The author's given.ts for the two behaviours whose start page takes `:id`: a post made through the app's own form, with locators only. */
const GIVEN = `import type { Browser, WebApp } from '@e2e-dev/web'

export interface GivenFixtures {
  app: WebApp
  browser: Browser
}

async function aPost({ browser }: GivenFixtures): Promise<Record<string, string>> {
  await browser.goto('/posts/create', { waitUntil: 'networkidle' })
  await browser.locator('input[name="title"]').fill('Given post')
  await browser.locator('button[type="submit"]').tap()
  await browser.waitForURL(/\\/posts\\/\\d+$/u)
  return { id: new URL(await browser.url()).pathname.split('/').at(-1)! }
}

export const given: Record<string, (fixtures: GivenFixtures) => Promise<Record<string, string> | void>> = {
  'AC-posts-update-1': aPost,
  'AC-posts-destroy-1': aPost,
}
`

async function setUpApp(app: string): Promise<{ password: string; appKey: string }> {
  await scaffoldMeasurementApp(app)
  await approveMeasurementPlan(app, behaviourPlan())
  await mustRun(app, ['bun', CLI, 'add', 'browser-tests', '--behaviours', '--agent', 'claude-code', '--no-install'])
  const packages = [...BEHAVIOUR_DEV_PACKAGES.map((name) => `${name}@${cliDependencyRange('devDependencies', name)}`), `${BEHAVIOUR_AGENTS['claude-code'].adapter.name}@${BEHAVIOUR_AGENTS['claude-code'].adapter.range}`]
  await mustRun(app, ['bun', 'add', '-d', ...packages])
  await writeFile(join(app, BEHAVIOURS_GIVEN_FILE), GIVEN)
  const password = randomBytes(18).toString('base64url')
  const env = await readFile(join(app, '.env'), 'utf8')
  const seeded = env.replace(/^BROWSER_TEST_PASSWORD=.*$/mu, `BROWSER_TEST_PASSWORD=${password}`)
  if (seeded === env) throw new Error('.env has no BROWSER_TEST_PASSWORD line to set, so the sign-in setup could not sign in.')
  await writeFile(join(app, '.env'), seeded)
  await mustRun(app, ['bun', CLI, 'browser:map'])
  if ((await readdir(join(app, GENERATED_BEHAVIOURS_DIR)).catch(() => [])).length === 0) throw new Error(`browser:map wrote nothing under ${GENERATED_BEHAVIOURS_DIR}.`)
  // The runner downloads its own Chromium on the first run; a Linux image also needs the libraries it links.
  if (process.platform === 'linux') await mustRun(app, ['bun', 'x', 'playwright-core', 'install-deps', 'chromium'])
  return { password, appKey: /^APP_KEY=(.*)$/mu.exec(seeded)?.[1] ?? '' }
}

async function resetDatabase(app: string): Promise<void> {
  for (const file of DATABASE_FILES) await rm(join(app, file), { force: true })
  await mustRun(app, ['bun', CLI, 'db:migrate'])
}

/**
 * The adapters hand the agent the runner's whole environment (`@e2e-dev/acp` drops only `E2E_SECRET_`/`E2E_USER_`),
 * so every name a model route reads (keys, tokens, Bedrock, Vertex, Foundry, their cloud credentials) is left out:
 * a step with no recording then fails as `missing` rather than running live behind the measurement's back.
 */
const MODEL_ROUTE_VARIABLE = /^(?:ANTHROPIC_|CLAUDE_|OPENAI_|CODEX_|AWS_|AZURE_|GOOGLE_|GCLOUD_|CLOUDSDK_|CLOUD_ML_|VERTEX_|BEDROCK_)/u

async function noLogin(root: string): Promise<Record<string, string | undefined>> {
  const hidden = Object.fromEntries(Object.keys(process.env).filter((name) => MODEL_ROUTE_VARIABLE.test(name)).map((name) => [name, undefined]))
  return { ...hidden, CLAUDE_CONFIG_DIR: await mkdtemp(join(root, 'no-claude-')), CODEX_HOME: await mkdtemp(join(root, 'no-codex-')) }
}

type Outcome = 'replayed' | 'live' | 'stale' | 'missing' | 'absent' | 'gap' | 'policy' | 'no-step' | 'failed' | 'not-run' | 'interrupted' | 'skipped'

interface ReportStep { kind: string; status: string; cache?: { mode?: string }; error?: { code?: string } }
interface ReportResult { titlePath: string[]; file: string; status: string; skip?: { cause?: string } | null; attempts?: Array<{ status: string; error?: { code?: string } | null; steps?: ReportStep[] }> }
interface Report { schemaVersion?: string; run?: { exitCode?: number; errors?: unknown[]; results?: ReportResult[] } }

/** One test's outcome in one run, from the runner's report: the exit code names one cause for a run that may hold several. */
function outcomeOf(result: ReportResult): Outcome {
  if (result.status === 'skipped') return result.skip?.cause === 'setup-failed' ? 'not-run' : 'skipped'
  if (result.status === 'interrupted') return 'interrupted'
  const attempt = result.attempts?.at(-1)
  const agentSteps = (attempt?.steps ?? []).filter((step) => step.kind === 'agent')
  // A generated behaviour test performs its behaviour in one agent step; a pass without one replayed nothing.
  if (result.status === 'passed' && agentSteps.length === 0) return 'no-step'
  if (result.status === 'passed') return agentSteps.every((step) => step.cache?.mode === 'self-finalized') ? 'replayed' : 'live'
  const failing = agentSteps.find((step) => step.status === 'failed')
  const code = attempt?.error?.code ?? failing?.error?.code
  if (code === 'REPLAY_STALE') return 'stale'
  // With no login a live step fails here: `missed` had no recording, a hand-off replayed part of one and then needed the model (§13.6).
  if (code === 'MODEL_PROVIDER_FAILED') return failing?.cache?.mode === 'agent-concluded' ? 'gap' : 'missing'
  if (code === 'POLICY_DENIED') return 'policy'
  return 'failed'
}

async function readReport(app: string): Promise<Report | undefined> {
  const report = await readFile(join(app, '.e2e/report.json'), 'utf8').then((text) => JSON.parse(text) as Report, () => undefined)
  // The report is the runner's own document; anything read from it rests on the format this was written against (RFC 0033 §13.8).
  if (report && report.schemaVersion !== 'report-1') throw new Error(`.e2e/report.json has schemaVersion ${report.schemaVersion}; this reads report-1.`)
  return report
}

/**
 * Every generated test's outcome, a filtered one included as skipped (this passes no filter), and `absent` for each
 * test of the manifest the run did not run: the recordings are for tests the generator does not write as they were.
 */
function outcomes(report: Report, expected: readonly string[]): Map<string, Outcome> {
  const seen = new Map((report.run?.results ?? [])
    .filter((result) => result.file.startsWith(GENERATED_BEHAVIOURS_DIR))
    .map((result) => [result.titlePath.join(' › '), outcomeOf(result)] as [string, Outcome]))
  for (const test of expected) if ((seen.get(test) ?? 'skipped') === 'skipped') seen.set(test, 'absent')
  return seen
}

/** What makes a run exit non-zero; `replayed`, `skipped` and `absent` never do, so a run holding only those that did not exit 0 failed elsewhere. */
const EXPLAINS_EXIT: ReadonlySet<Outcome> = new Set(['live', 'stale', 'missing', 'gap', 'policy', 'no-step', 'failed', 'not-run', 'interrupted'])

function runErrored(report: Report, exitCode: number, tonight: ReadonlyMap<string, Outcome>): boolean {
  return (report.run?.errors?.length ?? 0) > 0 || (exitCode !== 0 && ![...tonight.values()].some((outcome) => EXPLAINS_EXIT.has(outcome)))
}

type Verdict = 'pass' | 'skipped' | 'stale' | 'missing' | 'absent' | 'gap' | 'live' | 'policy' | 'no-step' | 'flaky' | 'defect' | 'not-run'

/** One word for the table; the summary counts each kind of outcome on its own, so this order hides nothing. */
function verdictOf(seen: readonly Outcome[]): Verdict {
  if (seen.every((outcome) => outcome === 'skipped')) return 'skipped'
  const kind = (['stale', 'missing', 'absent', 'gap', 'live', 'policy', 'no-step'] as const).find((outcome) => seen.includes(outcome))
  if (kind) return kind
  if (isDefect(seen)) return 'defect'
  if (seen.includes('failed') || seen.includes('interrupted')) return 'flaky'
  if (seen.includes('not-run')) return 'not-run'
  return 'pass'
}

/** Failed on every run that reached its step, as against failing on some. */
function isDefect(seen: readonly Outcome[]): boolean {
  const ran = seen.filter((outcome) => outcome === 'replayed' || outcome === 'failed')
  return ran.length > 0 && ran.every((outcome) => outcome === 'failed')
}

interface ReplayRecord { replay: number; exitCode: number; wallMs: number; reported: boolean; runError: boolean }
interface Summary {
  /** `current` while every recording replays; otherwise what a Guren change did to the fixture, which `--record` makes again. */
  fixture: 'current' | 'stale' | 'missing' | 'empty'
  clean: boolean
  flaky: number; defects: number; notRun: number; gap: number; live: number; policy: number; noStep: number; unreported: number; runErrors: number
}
interface Metrics {
  measuredAt: string
  commit: string | null
  runner: { os: string; image: string | null; cpus: number; bun: string }
  fixture: { entries: number; tests: number }
  replays: ReplayRecord[]
  tests: Array<{ test: string; verdict: Verdict; outcomes: Partial<Record<Outcome, number>> }>
  summary: Summary
}

/** Everything but the fixture's state: a night with any of these breaks the streak, whatever the fixture. */
function failuresOf(summary: Summary): number {
  return summary.flaky + summary.defects + summary.notRun + summary.gap + summary.live + summary.policy + summary.noStep + summary.unreported + summary.runErrors
}

function summarize(seen: ReadonlyMap<string, Outcome[]>, replays: readonly ReplayRecord[], entries: number): Pick<Metrics, 'tests' | 'summary'> {
  const tests = [...seen].map(([test, list]) => {
    const counts: Partial<Record<Outcome, number>> = {}
    for (const outcome of list) counts[outcome] = (counts[outcome] ?? 0) + 1
    return { test, verdict: verdictOf(list), outcomes: counts }
  }).sort((a, b) => a.test.localeCompare(b.test))
  const lists = [...seen.values()]
  const having = (...kinds: Outcome[]): number => lists.filter((list) => kinds.some((kind) => list.includes(kind))).length
  const fixture = entries === 0 ? 'empty' : having('missing', 'absent') > 0 ? 'missing' : having('stale') > 0 ? 'stale' : 'current'
  const failing = lists.filter((list) => list.includes('failed') || list.includes('interrupted'))
  const summary: Summary = {
    fixture, clean: false,
    flaky: failing.filter((list) => !isDefect(list)).length, defects: failing.filter(isDefect).length,
    notRun: having('not-run'), gap: having('gap'), live: having('live'), policy: having('policy'), noStep: having('no-step'),
    unreported: replays.filter((entry) => !entry.reported).length, runErrors: replays.filter((entry) => entry.runError).length,
  }
  return { tests, summary: { ...summary, clean: fixture === 'current' && failuresOf(summary) === 0 } }
}

async function readManifest(): Promise<string[]> {
  const manifest = JSON.parse(await readFile(MANIFEST_FILE, 'utf8')) as { tests?: unknown }
  if (!Array.isArray(manifest.tests) || manifest.tests.length === 0 || !manifest.tests.every((test) => typeof test === 'string')) {
    throw new Error(`${MANIFEST_FILE} names no test; make the fixture with --record.`)
  }
  return manifest.tests as string[]
}

async function writeSummary(lines: readonly string[]): Promise<void> {
  console.log(`\n${lines.join('\n')}`)
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`)
}

function summaryLines(metrics: Metrics): string[] {
  const { summary } = metrics
  const walls = metrics.replays.filter((entry) => entry.reported).map((entry) => entry.wallMs)
  const fixtureLine: Record<Metrics['summary']['fixture'], string> = {
    current: 'every recording replayed',
    stale: 'a recording no longer matches its page: a Guren change re-keyed it, so record the fixture again with `bun run smoke:browser-behaviours --record` and say so in the changeset',
    missing: 'a test has no recording, or a recorded test no longer runs: the generator or the runner pin changed its title or key, so record the fixture again',
    empty: 'the fixture holds no recording',
  }
  return [
    '## Behaviour specs replay (RFC 0033 §13, Open Question 13)',
    '',
    `${metrics.replays.length} replay(s) of ${metrics.fixture.entries} recording(s) for ${metrics.fixture.tests} test(s), each against a database migrated from empty and with no agent login. Fixture: ${summary.fixture}, ${fixtureLine[summary.fixture]}.`,
    `${summary.clean ? 'Clean' : 'Not clean'}: flaky ${summary.flaky}, defects ${summary.defects}, not run ${summary.notRun}, a recording with a gap ${summary.gap}, ran live ${summary.live}, policy ${summary.policy}, passed with no agent step ${summary.noStep}, unreported runs ${summary.unreported}, runs that failed outside a test ${summary.runErrors}.`,
    walls.length > 0 ? `One replay: ${(Math.min(...walls) / 1000).toFixed(1)}-${(Math.max(...walls) / 1000).toFixed(1)} s, the app's start included.` : 'No replay produced a report.',
    '',
    '| Test | Verdict | Outcomes |', '| --- | --- | --- |',
    ...metrics.tests.map((entry) => `| ${entry.test.replaceAll('|', '\\|')} | ${entry.verdict} | ${Object.entries(entry.outcomes).map(([outcome, n]) => `${outcome} ${n}`).join(', ')} |`),
  ]
}

async function replay(): Promise<void> {
  const replays = replayCount()
  const root = await mkdtemp(join(tmpdir(), 'guren-browser-behaviours-'))
  const app = join(root, 'app')
  const out = resolve(process.env.GUREN_BROWSER_OUT || join(root, 'out'))
  await mkdir(out, { recursive: true })
  console.log(`App: ${app}\nOutput: ${out}`)

  await setUpApp(app)
  const fixture = (await readdir(FIXTURE_DIR).catch(() => [])).filter((file) => file.endsWith('.json'))
  if (fixture.length === 0) throw new Error(`${FIXTURE_DIR} holds no recording, so there is nothing to replay; make it with --record.`)
  const expected = await readManifest()
  await mkdir(join(app, '.e2e/cache'), { recursive: true })
  for (const file of fixture) await cp(join(FIXTURE_DIR, file), join(app, '.e2e/cache', file))
  const hidden = await noLogin(root)

  const metrics: Metrics = {
    measuredAt: new Date().toISOString(),
    commit: process.env.GITHUB_SHA ?? null,
    runner: { os: process.platform, image: process.env.ImageOS ? `${process.env.ImageOS} ${process.env.ImageVersion ?? ''}`.trim() : null, cpus: cpus().length, bun: Bun.version },
    fixture: { entries: fixture.length, tests: expected.length },
    replays: [],
    tests: [],
    summary: { fixture: 'empty', clean: false, flaky: 0, defects: 0, notRun: 0, gap: 0, live: 0, policy: 0, noStep: 0, unreported: 0, runErrors: 0 },
  }
  const seen = new Map<string, Outcome[]>()
  for (let index = 1; index <= replays; index += 1) {
    await resetDatabase(app)
    await rm(join(app, '.e2e/report.json'), { force: true })
    const began = performance.now()
    const exitCode = await run(app, ['bun', 'run', 'test:behaviours:ci'], hidden)
    const wallMs = Math.round(performance.now() - began)
    const report = await readReport(app)
    // With no report there is nothing to call absent: the run counts as unreported, never as a re-keyed fixture.
    const tonight = report ? outcomes(report, expected) : new Map<string, Outcome>()
    if (report) await writeFile(join(out, `report-${index}.json`), `${JSON.stringify(report)}\n`)
    for (const [test, outcome] of tonight) seen.set(test, [...(seen.get(test) ?? []), outcome])
    const reported = report !== undefined && (report.run?.results ?? []).some((result) => result.file.startsWith(GENERATED_BEHAVIOURS_DIR))
    metrics.replays.push({ replay: index, exitCode, wallMs, reported, runError: report !== undefined && runErrored(report, exitCode, tonight) })
    Object.assign(metrics, summarize(seen, metrics.replays, fixture.length))
    await writeFile(join(out, 'behaviours.json'), `${JSON.stringify(metrics, null, 2)}\n`)
  }

  await writeSummary(summaryLines(metrics))
  // A green scheduled run shows no summary unless opened, and a re-keyed fixture is the signal this job exists for.
  if (process.env.GITHUB_ACTIONS && (metrics.summary.fixture === 'stale' || metrics.summary.fixture === 'missing')) {
    console.log(`::warning title=Behaviour fixture ${metrics.summary.fixture}::A Guren change re-keyed the recordings an app commits. Run bun run smoke:browser-behaviours --record, commit the fixture, and say in the changeset that apps record again.`)
  }
  console.log(`\nMetrics: ${join(out, 'behaviours.json')}\nApp kept at ${app}`)
  if (metrics.replays.every((entry) => !entry.reported)) throw new Error('No replay produced a report: nothing was measured.')
}

const SECRET_NAME = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|COOKIE|SESSION/iu

/** Every key and string a JSON document holds, decoded, so a secret written with `\u` escapes is still found. */
function decodedStrings(text: string): string {
  const out: string[] = []
  const walk = (value: unknown): void => {
    if (typeof value === 'string') out.push(value)
    else if (Array.isArray(value)) value.forEach(walk)
    else if (value !== null && typeof value === 'object') for (const [key, inner] of Object.entries(value)) { out.push(key); walk(inner) }
  }
  walk(JSON.parse(text))
  return out.join('\n')
}

/** What a recording must not carry into the repository: this machine's paths and names, the run's own secrets, and any secret this process inherited. */
function forbiddenIn(text: string, secrets: readonly string[]): string[] {
  const user = userInfo().username
  const inherited = Object.entries(process.env).filter(([name, value]) => SECRET_NAME.test(name) && value !== undefined).map(([, value]) => value!)
  const checks: Array<[string, string]> = [
    ['the home directory', homedir()], ['the temporary directory', tmpdir()], ['the host name', hostname()],
    ['a macOS home path', '/Users/'], ['a Linux home path', '/home/'], ['a temporary path', '/tmp/'], ['a macOS temporary path', '/var/folders/'], ['a macOS system path', '/private/'],
    ...(user.length >= 3 ? [['the user name', user] as [string, string]] : []),
    ...[...secrets, ...inherited].filter((secret) => secret.length >= 8).map((secret) => ['a secret', secret] as [string, string]),
  ]
  const haystack = `${text}\n${decodedStrings(text)}`
  return [...new Set(checks.filter(([, needle]) => needle !== '' && haystack.includes(needle)).map(([what]) => what))]
}

async function record(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'guren-browser-behaviours-record-'))
  const app = join(root, 'app')
  console.log(`App: ${app}`)
  const { password, appKey } = await setUpApp(app)

  await rm(join(app, '.e2e/cache'), { recursive: true, force: true })
  await resetDatabase(app)
  const live = await run(app, ['bun', 'run', 'test:behaviours'])
  const recorded = await readReport(app)
  const failed = [...(recorded ? outcomes(recorded, []) : new Map<string, Outcome>())].filter(([, outcome]) => outcome !== 'skipped' && outcome !== 'live' && outcome !== 'replayed')
  if (live !== 0 || !recorded || failed.length > 0) throw new Error(`The live run did not pass (exit ${live}): ${failed.map(([test, outcome]) => `${test}: ${outcome}`).join('; ') || 'no report'}. Nothing was written.`)

  await resetDatabase(app)
  const replayed = await run(app, ['bun', 'run', 'test:behaviours:ci'], await noLogin(root))
  const check = await readReport(app)
  const results = [...(check ? outcomes(check, []) : new Map<string, Outcome>())]
  const unreplayed = results.filter(([, outcome]) => outcome !== 'skipped' && outcome !== 'replayed')
  const tests = results.filter(([, outcome]) => outcome === 'replayed').map(([test]) => test).sort()
  if (replayed !== 0 || !check || (check.run?.errors?.length ?? 0) > 0 || unreplayed.length > 0 || tests.length === 0) {
    throw new Error(`The recordings did not replay with no login (exit ${replayed}): ${unreplayed.map(([test, outcome]) => `${test}: ${outcome}`).join('; ') || (tests.length === 0 ? 'no test replayed' : 'no report, or a run error')}. Nothing was written.`)
  }

  const cache = join(app, '.e2e/cache')
  const files = (await readdir(cache)).filter((file) => file.endsWith('.json')).sort()
  for (const file of files) {
    const hits = forbiddenIn(await readFile(join(cache, file), 'utf8'), [password, appKey])
    if (hits.length > 0) throw new Error(`${file} holds ${hits.join(' and ')}; nothing was written.`)
  }
  // A test the previous fixture replayed and this one does not is one the generator skips or renamed: said here, and in the manifest's diff.
  const before = await readManifest().catch(() => [] as string[])
  const dropped = before.filter((test) => !tests.includes(test))
  await rm(FIXTURE_DIR, { recursive: true, force: true })
  await mkdir(FIXTURE_DIR, { recursive: true })
  for (const file of files) await cp(join(cache, file), join(FIXTURE_DIR, file))
  await writeFile(MANIFEST_FILE, `${JSON.stringify({ tests }, null, 2)}\n`)
  console.log(`\nWrote ${files.length} recording(s) for ${tests.length} test(s) to ${FIXTURE_DIR}; they replayed with no login against an empty database.`)
  if (dropped.length > 0) console.log(`Replayed by the previous fixture and not by this one, so not measured:\n${dropped.map((test) => `  ${test}`).join('\n')}`)
}

interface Night { createdAt: string; metrics: Metrics | undefined }

/**
 * The nights so far, newest first: one directory per scheduled run under `dir`, holding the run's `run.json`
 * (`{ createdAt }`) and its behaviours.json at any depth when it kept one. A night that kept none ran and measured
 * nothing, so it ends the streak; only the runs older than the first that measured anything are passed over.
 */
async function readNights(dir: string): Promise<Night[]> {
  const runs = (await readdir(dir, { withFileTypes: true })).filter((entry) => entry.isDirectory())
  const nights = await Promise.all(runs.map(async (entry): Promise<Night> => {
    const runDir = join(dir, entry.name)
    const { createdAt } = JSON.parse(await readFile(join(runDir, 'run.json'), 'utf8')) as { createdAt: string }
    const file = (await readdir(runDir, { recursive: true })).find((name) => name.endsWith('behaviours.json'))
    return { createdAt, metrics: file ? JSON.parse(await readFile(join(runDir, file), 'utf8')) as Metrics : undefined }
  }))
  nights.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  let oldestMeasured = -1
  nights.forEach((night, index) => { if (night.metrics !== undefined) oldestMeasured = index })
  return nights.slice(0, oldestMeasured + 1)
}

async function aggregate(dir: string): Promise<void> {
  const nights = await readNights(dir)
  const title = ['## Behaviour specs replay across nights (RFC 0033 §13)', '']
  if (nights.length === 0) {
    await writeSummary([...title, 'No scheduled night has measured the behaviour specs yet.'])
    return
  }
  // A re-keyed night is left out of the streak, neither counted nor ending it: its recordings did not replay, which is the fixture's signal, not a failure.
  let clean = 0
  let replays = 0
  let ended: string | undefined
  for (const night of nights) {
    const summary = night.metrics?.summary
    if (!summary) { ended = `the night of ${night.createdAt.slice(0, 10)} kept no metrics`; break }
    if (failuresOf(summary) > 0 || summary.fixture === 'empty') { ended = `the night of ${night.createdAt.slice(0, 10)} was not clean`; break }
    if (summary.fixture !== 'current') continue
    clean += 1
    replays += night.metrics!.replays.length
  }
  const rekeyed = nights.filter((night) => night.metrics?.summary.fixture === 'stale' || night.metrics?.summary.fixture === 'missing')
  await writeSummary([
    ...title,
    `${nights.length} scheduled night(s) read. The latest ${clean} clean night(s) in a row${ended ? `, until ${ended}` : ''}: ${replays} replays with every recording replayed and no test failing${replays >= RULE_OF_THREE_MIN ? `; by the rule of three a failure rate under ${(300 / replays).toFixed(1)}% at 95% confidence` : ''}.`,
    rekeyed.length > 0
      ? `${rekeyed.length} night(s), left out of that count, found the fixture ${[...new Set(rekeyed.map((night) => night.metrics!.summary.fixture))].join(' or ')}, the latest on ${rekeyed[0]!.createdAt.slice(0, 10)}: a Guren change re-keyed the recordings an app commits.`
      : 'No night found the fixture stale or missing.',
  ])
}

export { forbiddenIn, outcomes, runErrored, summarize, type Report }

if (import.meta.main) {
  const [flag, dir] = process.argv.slice(2)
  if (flag === '--aggregate') {
    if (!dir) throw new Error('Usage: browser-behaviours.ts --aggregate <directory holding one directory per night>')
    await aggregate(resolve(dir))
  } else if (flag === '--record') {
    await record()
  } else {
    await replay()
  }
}
