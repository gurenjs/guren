import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { parseExpression } from '@babel/parser'

import { createAppListedFiles } from '../src/app-entry'
import { envBuilderSignature } from '../src/env-declarations'
import { parseSourceFile } from '../src/parse-cache'
import type { PlanAppDetail } from '../src/plan/app-detail'
import { loadPlanAppState } from '../src/plan/app-state'
import { canonicalJson } from '../src/plan/identity'
import { planElementsWithoutBehaviour } from '../src/plan/reach'
import { createPlanRevision } from '../src/plan/revision'
import { PlanDraftSchema, planDraftJsonSchema } from '../src/plan/schema'
import { judgePlan } from '../src/plan/status'
import { derivePlanTasks } from '../src/plan/tasks'
import { validatePlan } from '../src/plan/validate'
import { loadCommentsPlan, planAppState } from './plan-fixture'

const ADD = { kind: 'add' as const }
const PROVIDER = { id: 'provider.jobs', change: ADD, className: 'JobsProvider', purpose: 'Registers the queue jobs' }
const CONFIG = { id: 'config.queue', change: ADD, name: 'queue' }

function draft(extra: Record<string, unknown> = {}, planVersion = 2) {
  return PlanDraftSchema.parse({ planVersion, title: 'Jobs', summary: 'Queue jobs.', scope: { goals: [], nonGoals: [] }, locale: 'en', ...extra })
}

const failures = (plan: ReturnType<typeof draft>, app = planAppState()) =>
  validatePlan(plan, app).filter((result) => result.status !== 'pass').map((result) => [result.key, result.status])

describe('the providers and config sections of a plan (RFC 0040 §5)', () => {
  test('should keep a version 1 plan as it parses today, with neither section in its bytes', () => {
    const parsed = PlanDraftSchema.parse(loadCommentsPlan())
    expect(parsed.planVersion).toBe(1)
    expect('providers' in parsed || 'config' in parsed).toBe(false)
    expect(canonicalJson(parsed)).not.toContain('"providers"')
  })

  test('should refuse either section on a version 1 plan, and read an empty one as absent', () => {
    const refused = PlanDraftSchema.safeParse({ ...loadCommentsPlan(), providers: [PROVIDER] })
    expect(refused.success).toBe(false)
    expect(refused.error?.issues.map((issue) => [issue.path.join('.'), issue.message])).toEqual([['providers', 'needs planVersion 2']])
    expect(canonicalJson(draft({ providers: [], config: [] }))).toBe(canonicalJson(draft()))
    expect(PlanDraftSchema.safeParse({ ...loadCommentsPlan(), config: [] }).success).toBe(true)
  })

  test('should take only an add or an existing entry', () => {
    for (const change of [{ kind: 'alter' }, { kind: 'drop', reason: 'gone' }, { kind: 'rename', from: 'Old' }]) {
      expect(PlanDraftSchema.safeParse({ ...draft(), providers: [{ ...PROVIDER, change }] }).success).toBe(false)
    }
    // The name is a file's stem, spliced into its path.
    for (const className of ['Queue/JobsProvider', 'JobsProvider.ts', '../Http/Controllers/PostController']) {
      expect(PlanDraftSchema.safeParse({ ...draft(), providers: [{ ...PROVIDER, className }] }).success).toBe(false)
    }
    expect(PlanDraftSchema.safeParse({ ...draft(), config: [{ ...CONFIG, name: 'rate-limit' }] }).success).toBe(false)
    const schema = planDraftJsonSchema() as { properties: Record<string, unknown>; required: string[] }
    expect(Object.keys(schema.properties)).toEqual(expect.arrayContaining(['providers', 'config']))
    expect(schema.required).not.toContain('providers')
  })

  test('should judge each name against the application, as the other class-named sections are', () => {
    const plan = draft({ providers: [PROVIDER], config: [CONFIG] })
    expect(failures(plan)).toEqual([])
    expect(failures(plan, planAppState({ providers: ['JobsProvider'], config: ['queue'] }))).toEqual([
      ['plan:app-collision', 'fail'],
      ['plan:app-collision', 'fail'],
    ])
    expect(failures(draft({ config: [{ ...CONFIG, change: { kind: 'existing' } }] }))).toEqual([['plan:app-missing', 'fail']])
  })

  test('should refuse two elements of one name, and a provider an added policy implies', () => {
    expect(failures(draft({ config: [CONFIG, { ...CONFIG, id: 'config.queue.again' }] }))).toEqual([['plan:duplicate-entry', 'fail']])
    const implied = draft({
      models: [{ id: 'model.post', change: { kind: 'existing' }, name: 'Post', table: 'posts', columns: [], relationships: [], fillable: [] }],
      policies: [{ id: 'policy.post', change: ADD, name: 'PostPolicy', model: 'model.post', abilities: [] }],
      providers: [{ ...PROVIDER, className: 'PostPolicyProvider' }],
    })
    expect(failures(implied).filter(([key]) => key === 'plan:provider-implied')).toEqual([['plan:provider-implied', 'fail']])
  })

  test('should call an entry wired once the application entry lists its file', () => {
    const plan = draft({ providers: [PROVIDER], config: [CONFIG] })
    const app = (entryLists: PlanAppDetail['entryLists']) => planAppState({
      providers: ['JobsProvider'],
      config: ['queue'],
      detail: {
        providers: [{ className: 'JobsProvider', module: null, file: 'app/Providers/JobsProvider.ts' }],
        config: [{ className: 'queue', module: null, file: 'config/queue.ts' }],
        entryLists,
      } as PlanAppDetail,
    })
    const states = (entryLists: PlanAppDetail['entryLists']) => judgePlan(plan, app(entryLists)).elements.map((element) => [element.id, element.state])

    expect(states({ file: 'src/app.ts', providers: { files: ['app/Providers/JobsProvider'], untraced: false }, config: { files: ['config/queue'], untraced: false } }))
      .toEqual([['provider.jobs', 'wired'], ['config.queue', 'wired']])
    expect(states({ file: 'src/app.ts', providers: { files: [], untraced: false }, config: { files: [], untraced: true } }))
      .toEqual([['provider.jobs', 'present'], ['config.queue', 'present']])
    expect(judgePlan(plan, planAppState()).elements.map((element) => element.state)).toEqual(['planned', 'planned'])
    const wired = judgePlan(plan, app({ file: 'src/app.ts', providers: { files: ['app/Providers/JobsProvider'], untraced: false }, config: undefined }))
    // Unregistering is what unwires it, so the entry is part of what a verified record fingerprints.
    expect(wired.elements[0]?.files).toEqual(['app/Providers/JobsProvider.ts', 'src/app.ts'])
  })

  test('should place an entry in Foundation, accepted at approval on its step alone', () => {
    const plan = draft({ providers: [PROVIDER], config: [CONFIG] })
    const derivation = derivePlanTasks(plan)
    expect(derivation.tasks.map((task) => task.steps.map((step) => [step.id, step.elementIds]))).toEqual([[['task/foundation/http', ['provider.jobs', 'config.queue']]]])
    expect(derivation.notes).toEqual([])
    expect(planElementsWithoutBehaviour(plan)).toEqual([{ id: 'provider.jobs', section: 'providers' }, { id: 'config.queue', section: 'config' }])
    expect(planElementsWithoutBehaviour(draft({ config: [{ ...CONFIG, change: { kind: 'existing' } }] }))).toEqual([])
  })

  test('should move a version 1 plan to version 2 when a revision adds an entry', () => {
    const parent = draft({}, 1)
    const revised = createPlanRevision(parent, { ops: [{ op: 'add', section: 'config', element: CONFIG, reason: 'The queue needs its config.' }] })
    if (!revised.ok) throw new Error(JSON.stringify(revised.rejections))
    expect(revised.plan.planVersion).toBe(2)
    expect(revised.plan.config).toEqual([CONFIG])
  })
})

describe('the env section of a plan (RFC 0040 §5)', () => {
  const ENV = { id: 'env.queue', change: ADD, key: 'QUEUE_CONNECTION', default: 'sync' }

  test('should hold a key as guren plugin states a manifest key, on a version 2 plan', () => {
    expect(PlanDraftSchema.safeParse({ ...loadCommentsPlan(), env: [ENV] }).success).toBe(false)
    expect(PlanDraftSchema.safeParse({ ...draft(), env: [{ ...ENV, key: 'queue-connection' }] }).success).toBe(false)
    expect(PlanDraftSchema.safeParse({ ...draft(), env: [{ ...ENV, type: 'json' }] }).success).toBe(false)
    expect(canonicalJson(draft({ env: [] }))).toBe(canonicalJson(draft()))
  })

  test('should refuse a key guren plugin would refuse, two elements of one key, and an added key the application declares', () => {
    expect(failures(draft({ env: [{ ...ENV, type: 'port', default: 'sync' }] }))).toEqual([['plan:env-declaration', 'fail']])
    for (const key of ['GUREN_TESTING', 'NODE_ENV']) expect([key, failures(draft({ env: [{ ...ENV, key }] }))]).toEqual([key, [['plan:env-declaration', 'fail']]])
    expect(PlanDraftSchema.safeParse({ ...draft(), env: [{ ...ENV, key: 'apiKey' }] }).success).toBe(false)
    expect(failures(draft({ env: [ENV, { ...ENV, id: 'env.queue.again' }] }))).toEqual([['plan:duplicate-entry', 'fail']])
    expect(failures(draft({ env: [ENV] }), planAppState({ env: ['QUEUE_CONNECTION'] }))).toEqual([['plan:app-collision', 'fail']])
  })

  test('should judge a declared key by what its chain declares', () => {
    const plan = draft({ env: [ENV] })
    const state = (source: string, signature: string | undefined) => planAppState({ env: ['QUEUE_CONNECTION'], detail: { env: [{ key: 'QUEUE_CONNECTION', source, signature }] } as PlanAppDetail })
    const verdicts = (source: string) => judgePlan(plan, state(source, envBuilderSignature(parseExpression(source) as never))).elements.map((element) => element.properties.map((property) => property.verdict))
    expect(verdicts("Env.string().default('sync')")).toEqual([['match']])
    expect(verdicts('Env.string()')).toEqual([['differ']])
    expect(planElementsWithoutBehaviour(plan)).toEqual([{ id: 'env.queue', section: 'env' }])
  })

  test('should read the keys config/env.ts declares, and say when its literal cannot be read', async () => {
    const root = await mkdtemp(join(tmpdir(), 'plan-env-section-'))
    await mkdir(join(root, 'config'), { recursive: true })
    await writeFile(join(root, 'config/env.ts'), "import { defineEnv, Env } from '@guren/core'\nconst env = defineEnv({ PORT: Env.port().default(3333), APP_NAME: Env.string() })\nexport default env\n")
    expect((await loadPlanAppState(root)).env).toEqual([{ name: 'APP_NAME', module: null }, { name: 'PORT', module: null }])
    await writeFile(join(root, 'config/env.ts'), "import { defineEnv, Env } from '@guren/core'\nconst env = defineEnv({ ...shared })\nexport default env\n")
    expect((await loadPlanAppState(root)).env).toEqual({ unreadable: expect.stringContaining('config/env.ts') })
  })
})

describe('the application entry lists plan:status reads', () => {
  test('should name the default imports each list registers, and say when one is no default import', () => {
    const source = [
      "import { createApp } from '@guren/core'",
      "import JobsProvider from '../app/Providers/JobsProvider.js'",
      "import { Named } from '../app/Providers/Named.js'",
      "import database from '../config/database.js'",
      "import queue from '../config/queue'",
      'const app = createApp({ providers: [JobsProvider, Named], config: [database, queue] })',
      'export default app',
    ].join('\n')
    const lists = createAppListedFiles(parseSourceFile(source, 'src/app.ts')!.program, '/app', '/app/src/app.ts')
    expect(lists).toEqual({
      providers: { files: ['/app/app/Providers/JobsProvider'], untraced: true },
      config: { files: ['/app/config/database', '/app/config/queue'], untraced: false },
    })
    const read = (text: string) => createAppListedFiles(parseSourceFile(text, 'src/app.ts')!.program, '/app', '/app/src/app.ts')
    expect(read("import { createApp } from '@guren/core'\nconst app = createApp({ ...shared })")).toBeNull()
    // Only the framework's factory, called once at the top level, is what the application registers.
    expect(read("import { createApp } from '@guren/core'\nimport queue from '../config/queue.js'\nfunction preview() { return createApp({ config: [queue] }) }\nconst app = createApp({ config: [] })")).toBeNull()
    expect(read("import * as core from '@guren/core'\nimport queue from '../config/queue.js'\nfunction createApp(options: object) { return core.createApp(options) }\nconst app = createApp({ config: [queue] })")).toBeNull()
  })

  test('should read the providers and config the application holds from their directories', async () => {
    const root = await mkdtemp(join(tmpdir(), 'plan-entry-sections-'))
    const files: Record<string, string> = {
      'package.json': '{"name":"app","type":"module"}',
      'app/Providers/JobsProvider.ts': 'export default class JobsProvider {}\n',
      'config/queue.ts': 'export default {}\n',
      'config/database.ts': 'export default {}\n',
      // A nested file is no entry `createApp()` imports by convention, whatever its stem.
      'config/legacy/mail.ts': 'export default {}\n',
      'app/Providers/Nested/MailProvider.ts': 'export default class MailProvider {}\n',
    }
    for (const [path, content] of Object.entries(files)) {
      await mkdir(dirname(join(root, path)), { recursive: true })
      await writeFile(join(root, path), content)
    }
    const state = await loadPlanAppState(root)
    expect(state.providers).toEqual([{ name: 'JobsProvider', module: null }])
    expect(state.config).toEqual([{ name: 'database', module: null }, { name: 'queue', module: null }])
  })
})
