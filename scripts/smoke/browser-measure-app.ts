/**
 * The app the browser measurements run on (RFC 0033 M4 and §13): a golden-path-shaped app, auth and
 * a posts resource on SQLite, built from this checkout's packages, with one approved plan.
 * `browser-tests.ts` measures the Playwright specs on it and `browser-behaviours.ts` the behaviour specs.
 */
import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

import type { z } from 'zod'

import type { PlanDraftSchema } from '../../packages/cli/src/plan/schema'
import { PLAN_VERSION } from '../../packages/cli/src/plan/version'
import { inheritedEnv } from './inherited-env'
import { assertSingleInstalledCopies, ensureBuiltPackages, rewriteAppDependencies, vendorLocalPackages } from './local-packages'

export const repoRoot = resolve(import.meta.dir, '../..')
export const CLI = join(repoRoot, 'packages/cli/src/bin.ts')
const CREATE_APP = join(repoRoot, 'packages/create-app/src/cli.ts')
export const PLAN_FILE = 'docs/plans/browser-measure/plan.json'

// The CLI runs from this checkout's source while the app installs its own @guren/orm.
export const appEnv = (): Record<string, string | undefined> => ({ ...inheritedEnv(), GUREN_QUIET_DUPLICATE_ORM: '1' })

/** `env` is laid over `appEnv()`; a name given as `undefined` is left out of the child's environment. */
export async function run(cwd: string, command: string[], env: Record<string, string | undefined> = {}): Promise<number> {
  const merged = Object.fromEntries(Object.entries({ ...appEnv(), ...env }).filter((entry): entry is [string, string] => entry[1] !== undefined))
  const child = Bun.spawn(command, { cwd, env: merged, stdout: 'inherit', stderr: 'inherit' })
  return child.exited
}

export async function mustRun(cwd: string, command: string[], env?: Record<string, string | undefined>): Promise<void> {
  const code = await run(cwd, command, env)
  if (code !== 0) throw new Error(`${command.join(' ')} exited ${code} in ${cwd}`)
}

export type PlanInput = z.input<typeof PlanDraftSchema>
type ActionInput = NonNullable<PlanInput['controllers']>[number]['actions'][number]

/**
 * Every element `existing`: the plan describes what `add resource posts` wrote, so it approves
 * against the app as it stands. A field's label is what the scaffolded `<Field>` shows with no
 * translation: `humanizeFieldName()` of its name in `@guren/inertia-client/forms`.
 */
export function measurementPlan(): PlanInput {
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
        form: { validator: 'validator.post', submitsTo: 'route.posts.store', fields: [{ field: 'title', label: 'Title', input: 'text' }] },
        actions: [{ label: 'Create', route: 'route.posts.store' }], states: {},
      },
    ],
  }
}

/** Creates the app at `app` from this checkout's packages, with auth and the posts resource migrated. */
export async function scaffoldMeasurementApp(app: string): Promise<void> {
  await ensureBuiltPackages()
  await mustRun(repoRoot, ['bun', CREATE_APP, app, '--mode', 'ssr', '--db', 'sqlite'])
  await rewriteAppDependencies(app, await vendorLocalPackages(join(app, '.guren-vendor')), 'The browser measurement app')
  await mustRun(app, ['bun', 'install'])
  await assertSingleInstalledCopies(app)
  for (const command of [['add', 'auth'], ['add', 'resource', 'posts'], ['codegen', '--force'], ['make:migration'], ['db:migrate']]) {
    await mustRun(app, ['bun', CLI, ...command])
  }
}

/** Writes `plan` at PLAN_FILE, commits the app (approval refuses a dirty tree) and approves the plan. */
export async function approveMeasurementPlan(app: string, plan: PlanInput): Promise<void> {
  await mkdir(dirname(join(app, PLAN_FILE)), { recursive: true })
  await writeFile(join(app, PLAN_FILE), `${JSON.stringify(plan, null, 2)}\n`)
  await appendFile(join(app, '.gitignore'), '\n.guren-vendor/\n')
  const git = ['git', '-c', 'user.name=Smoke', '-c', 'user.email=smoke@example.test', '-c', 'commit.gpgsign=false']
  for (const command of [['git', 'init', '-q'], ['git', 'add', '-A'], [...git, 'commit', '-q', '--no-verify', '-m', 'scaffold']]) {
    await mustRun(app, command)
  }
  await mustRun(app, ['bun', CLI, 'plan:approve', PLAN_FILE])
}
