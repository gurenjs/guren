import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { createAppListedFiles } from '../src/app-entry'
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
    expect(createAppListedFiles(parseSourceFile("const app = createApp({ ...shared })", 'src/app.ts')!.program, '/app', '/app/src/app.ts')).toBeNull()
  })

  test('should read the providers and config the application holds from their directories', async () => {
    const root = await mkdtemp(join(tmpdir(), 'plan-entry-sections-'))
    const files: Record<string, string> = {
      'package.json': '{"name":"app","type":"module"}',
      'app/Providers/JobsProvider.ts': 'export default class JobsProvider {}\n',
      'config/queue.ts': 'export default {}\n',
      'config/database.ts': 'export default {}\n',
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
