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

/** No agent can run a step: a step with no recording then fails as `missing` rather than recording behind the measurement's back. */
async function noLogin(root: string): Promise<Record<string, string | undefined>> {
  const claude = await mkdtemp(join(root, 'no-claude-'))
  const codex = await mkdtemp(join(root, 'no-codex-'))
  return { CLAUDE_CONFIG_DIR: claude, CODEX_HOME: codex, ANTHROPIC_API_KEY: undefined, OPENAI_API_KEY: undefined, CLAUDE_CODE_OAUTH_TOKEN: undefined }
}

type Outcome = 'replayed' | 'live' | 'stale' | 'missing' | 'gap' | 'policy' | 'failed' | 'not-run' | 'interrupted' | 'skipped'

interface ReportStep { kind: string; status: string; cache?: { mode?: string }; error?: { code?: string } }
interface ReportResult { titlePath: string[]; file: string; status: string; skip?: { cause?: string } | null; attempts?: Array<{ status: string; error?: { code?: string } | null; steps?: ReportStep[] }> }
interface Report { schemaVersion?: string; run?: { exitCode?: number; results?: ReportResult[] } }

/** One test's outcome in one run, from the runner's report: the exit code names one cause for a run that may hold several. */
function outcomeOf(result: ReportResult): Outcome {
  if (result.status === 'skipped') return result.skip?.cause === 'setup-failed' ? 'not-run' : 'skipped'
  if (result.status === 'interrupted') return 'interrupted'
  const attempt = result.attempts?.at(-1)
  const agentSteps = (attempt?.steps ?? []).filter((step) => step.kind === 'agent')
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

function outcomes(report: Report): Map<string, Outcome> {
  return new Map((report.run?.results ?? [])
    .filter((result) => result.skip?.cause !== 'filtered' && result.file.startsWith(GENERATED_BEHAVIOURS_DIR))
    .map((result) => [result.titlePath.join(' › '), outcomeOf(result)]))
}

type Verdict = 'pass' | 'skipped' | 'stale' | 'missing' | 'gap' | 'live' | 'policy' | 'flaky' | 'defect' | 'not-run'

function verdictOf(seen: readonly Outcome[]): Verdict {
  const has = (outcome: Outcome): boolean => seen.includes(outcome)
  if (seen.every((outcome) => outcome === 'skipped')) return 'skipped'
  if (has('stale')) return 'stale'
  if (has('missing')) return 'missing'
  if (has('gap')) return 'gap'
  if (has('live')) return 'live'
  if (has('policy')) return 'policy'
  const ran = seen.filter((outcome) => outcome === 'replayed' || outcome === 'failed')
  if (ran.length > 0 && ran.every((outcome) => outcome === 'failed')) return 'defect'
  if (has('failed') || has('interrupted')) return 'flaky'
  if (has('not-run')) return 'not-run'
  return 'pass'
}

interface ReplayRecord { replay: number; exitCode: number; wallMs: number; reported: boolean }
interface Metrics {
  measuredAt: string
  commit: string | null
  runner: { os: string; image: string | null; cpus: number; bun: string }
  fixture: { entries: number }
  replays: ReplayRecord[]
  tests: Array<{ test: string; verdict: Verdict; outcomes: Partial<Record<Outcome, number>> }>
  /** `current` while every recording replays; otherwise what a Guren change did to the fixture, which `--record` makes again. */
  summary: { fixture: 'current' | 'stale' | 'missing' | 'empty'; clean: boolean; flaky: number; defects: number; notRun: number; gap: number; live: number; policy: number; unreported: number }
}

function summarize(seen: ReadonlyMap<string, Outcome[]>, replays: readonly ReplayRecord[], entries: number): Pick<Metrics, 'tests' | 'summary'> {
  const tests = [...seen].map(([test, list]) => {
    const counts: Partial<Record<Outcome, number>> = {}
    for (const outcome of list) counts[outcome] = (counts[outcome] ?? 0) + 1
    return { test, verdict: verdictOf(list), outcomes: counts }
  }).sort((a, b) => a.test.localeCompare(b.test))
  const count = (verdict: Verdict): number => tests.filter((entry) => entry.verdict === verdict).length
  const unreported = replays.filter((entry) => !entry.reported).length
  const fixture = entries === 0 ? 'empty' : count('missing') > 0 ? 'missing' : count('stale') > 0 ? 'stale' : 'current'
  const summary = { fixture, flaky: count('flaky'), defects: count('defect'), notRun: count('not-run'), gap: count('gap'), live: count('live'), policy: count('policy'), unreported } as const
  const failures = summary.flaky + summary.defects + summary.notRun + summary.gap + summary.live + summary.policy + unreported
  return { tests, summary: { ...summary, clean: fixture === 'current' && failures === 0 } }
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
    missing: 'a test has no recording: the generator or the runner pin changed its title or key, so record the fixture again',
    empty: 'the fixture holds no recording',
  }
  return [
    '## Behaviour specs replay (RFC 0033 §13, Open Question 13)',
    '',
    `${metrics.replays.length} replay(s) of ${metrics.fixture.entries} recording(s), each against a database migrated from empty and with no agent login. Fixture: ${summary.fixture}, ${fixtureLine[summary.fixture]}.`,
    `${summary.clean ? 'Clean' : 'Not clean'}: flaky ${summary.flaky}, defects ${summary.defects}, not run ${summary.notRun}, a recording with a gap ${summary.gap}, ran live ${summary.live}, policy ${summary.policy}, unreported runs ${summary.unreported}.`,
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
  await mkdir(join(app, '.e2e/cache'), { recursive: true })
  for (const file of fixture) await cp(join(FIXTURE_DIR, file), join(app, '.e2e/cache', file))
  const hidden = await noLogin(root)

  const metrics: Metrics = {
    measuredAt: new Date().toISOString(),
    commit: process.env.GITHUB_SHA ?? null,
    runner: { os: process.platform, image: process.env.ImageOS ? `${process.env.ImageOS} ${process.env.ImageVersion ?? ''}`.trim() : null, cpus: cpus().length, bun: Bun.version },
    fixture: { entries: fixture.length },
    replays: [],
    tests: [],
    summary: { fixture: 'empty', clean: false, flaky: 0, defects: 0, notRun: 0, gap: 0, live: 0, policy: 0, unreported: 0 },
  }
  const seen = new Map<string, Outcome[]>()
  for (let index = 1; index <= replays; index += 1) {
    await resetDatabase(app)
    await rm(join(app, '.e2e/report.json'), { force: true })
    const began = performance.now()
    const exitCode = await run(app, ['bun', 'run', 'test:behaviours:ci'], hidden)
    const wallMs = Math.round(performance.now() - began)
    const report = await readReport(app)
    const tonight = report ? outcomes(report) : new Map<string, Outcome>()
    if (report) await writeFile(join(out, `report-${index}.json`), `${JSON.stringify(report)}\n`)
    for (const [test, outcome] of tonight) seen.set(test, [...(seen.get(test) ?? []), outcome])
    metrics.replays.push({ replay: index, exitCode, wallMs, reported: tonight.size > 0 })
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

/** What a recording must not carry into the repository: this machine's paths and names, and the run's own secrets. */
function forbiddenIn(text: string, secrets: readonly string[]): string[] {
  const user = userInfo().username
  const checks: Array<[string, string]> = [
    ['the home directory', homedir()], ['the host name', hostname()], ['a macOS home path', '/Users/'], ['a Linux home path', '/home/'],
    ...(user.length >= 3 ? [['the user name', user] as [string, string]] : []),
    ...secrets.filter((secret) => secret.length >= 8).map((secret) => ['a secret of the run', secret] as [string, string]),
  ]
  return checks.filter(([, needle]) => needle !== '' && text.includes(needle)).map(([what]) => what)
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
  const failed = [...(recorded ? outcomes(recorded) : new Map<string, Outcome>())].filter(([, outcome]) => outcome !== 'skipped' && outcome !== 'live' && outcome !== 'replayed')
  if (live !== 0 || !recorded || failed.length > 0) throw new Error(`The live run did not pass (exit ${live}): ${failed.map(([test, outcome]) => `${test}: ${outcome}`).join('; ') || 'no report'}. Nothing was written.`)

  await resetDatabase(app)
  const replayed = await run(app, ['bun', 'run', 'test:behaviours:ci'], await noLogin(root))
  const check = await readReport(app)
  const unreplayed = [...(check ? outcomes(check) : new Map<string, Outcome>())].filter(([, outcome]) => outcome !== 'skipped' && outcome !== 'replayed')
  if (replayed !== 0 || !check || unreplayed.length > 0) throw new Error(`The recordings did not replay with no login (exit ${replayed}): ${unreplayed.map(([test, outcome]) => `${test}: ${outcome}`).join('; ') || 'no report'}. Nothing was written.`)

  const cache = join(app, '.e2e/cache')
  const files = (await readdir(cache)).filter((file) => file.endsWith('.json')).sort()
  for (const file of files) {
    const hits = forbiddenIn(await readFile(join(cache, file), 'utf8'), [password, appKey])
    if (hits.length > 0) throw new Error(`${file} holds ${hits.join(' and ')}; nothing was written.`)
  }
  await rm(FIXTURE_DIR, { recursive: true, force: true })
  await mkdir(FIXTURE_DIR, { recursive: true })
  for (const file of files) await cp(join(cache, file), join(FIXTURE_DIR, file))
  console.log(`\nWrote ${files.length} recording(s) to ${FIXTURE_DIR}; they replayed with no login against an empty database.`)
}

/** The nights so far, newest first: each night's behaviours.json under `dir`, at any depth. */
async function aggregate(dir: string): Promise<void> {
  const files = (await readdir(dir, { recursive: true })).filter((file) => file.endsWith('behaviours.json'))
  const nights = (await Promise.all(files.map(async (file) => JSON.parse(await readFile(join(dir, file), 'utf8')) as Metrics)))
    .sort((a, b) => b.measuredAt.localeCompare(a.measuredAt))
  if (nights.length === 0) throw new Error(`No behaviours.json under ${dir}.`)
  const streak = nights.findIndex((night) => !night.summary.clean)
  const cleanNights = streak === -1 ? nights.length : streak
  const replays = nights.slice(0, cleanNights).reduce((total, night) => total + night.replays.length, 0)
  const rekeyed = nights.filter((night) => night.summary.fixture === 'stale' || night.summary.fixture === 'missing')
  await writeSummary([
    '## Behaviour specs replay across nights (RFC 0033 §13)',
    '',
    `${nights.length} night(s) read. The latest ${cleanNights} in a row are clean (${replays} replays with every recording replayed and no test failing${replays >= RULE_OF_THREE_MIN ? `; by the rule of three a failure rate under ${(300 / replays).toFixed(1)}% at 95% confidence` : ''}).`,
    rekeyed.length > 0
      ? `${rekeyed.length} night(s) found the fixture ${[...new Set(rekeyed.map((night) => night.summary.fixture))].join(' or ')}, the latest on ${rekeyed[0]!.measuredAt.slice(0, 10)}: a Guren change re-keyed the recordings an app commits.`
      : 'No night found the fixture stale or missing.',
  ])
}

const [flag, dir] = process.argv.slice(2)
if (flag === '--aggregate') {
  if (!dir) throw new Error('Usage: browser-behaviours.ts --aggregate <directory of behaviours.json files>')
  await aggregate(resolve(dir))
} else if (flag === '--record') {
  await record()
} else {
  await replay()
}
