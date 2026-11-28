import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { composeEnvDeclarations } from '../src/app-env'
import { envKeyAdditions, envKeyValue } from '../src/change/app-env'
import { envBuilderSignature, planEnvEntry, plannedEnvSignature } from '../src/env-declarations'
import { providerTemplate } from '../src/make-provider'
import { formatPlanScaffoldEntries, planScaffoldEntriesFile, planScaffoldEntriesWork } from '../src/plan-scaffold'
import { planScaffoldEntries } from '../src/plan/scaffold'
import { PlanSchema } from '../src/plan/schema'
import { derivePlanTasks, findPlanStep } from '../src/plan/tasks'
import { writePlanActiveStep } from '../src/plan/state'
import { approvedAgainst, approvePlanFile, refusal } from './plan-fixture'

const ADD = { kind: 'add' as const }
const PROVIDER = { id: 'provider.reports', change: ADD, className: 'ReportsProvider', purpose: 'Schedules the weekly reports' }
const ENV = { id: 'env.reportsBucket', change: ADD, key: 'REPORTS_BUCKET', default: 'reports', description: 'Where reports are stored.' }
const CONFIG = { id: 'config.queue', change: ADD, name: 'queue' }
const STEP = 'task/foundation/http'
const PLAN_FILE = 'reports.plan.json'

const APP_ENTRY = `import { createApp } from '@guren/core'
import routes from '../routes/web'

export default createApp({
  routes,
  providers: [],
})
`
const ENV_SCHEMA = `import { defineEnv, Env } from '@guren/core'

export default defineEnv({
  APP_KEY: Env.string(),
})
`

function document(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return approvedAgainst({
    planVersion: 2,
    title: 'Reports',
    summary: 'Weekly reports.',
    scope: { goals: [], nonGoals: [] },
    locale: 'en',
    providers: [PROVIDER],
    env: [ENV],
    config: [CONFIG],
    ...extra,
  })
}

interface AppOptions {
  files?: Record<string, string | null>
  plan?: Record<string, unknown>
  mark?: string | null
}

async function createApp(options: AppOptions = {}): Promise<{ dir: string; plan: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'guren-plan-entries-'))
  const files: Record<string, string | null> = { 'src/app.ts': APP_ENTRY, 'config/env.ts': ENV_SCHEMA, '.env.example': 'APP_KEY=\n', ...options.files }
  for (const [path, contents] of Object.entries(files)) {
    if (contents === null) continue
    await mkdir(dirname(join(dir, path)), { recursive: true })
    await writeFile(join(dir, path), contents)
  }
  const plan = join(dir, PLAN_FILE)
  await writeFile(plan, `${JSON.stringify(options.plan ?? document(), null, 2)}\n`)
  await approvePlanFile(plan)
  const marked = options.mark === undefined ? STEP : options.mark
  if (marked !== null) await writePlanActiveStep(dir, 'reports', { plan: PLAN_FILE, step: marked, startedAt: '2026-11-22T00:00:00.000Z', continuations: 0 })
  return { dir, plan }
}

const read = (dir: string, path: string): Promise<string> => readFile(join(dir, path), 'utf8')

describe('plan:scaffold --entries (RFC 0040 §5)', () => {
  test('should own the added providers, env keys and config entries of an http step, and nothing of another kind of step', () => {
    const plan = PlanSchema.parse(document())
    const found = findPlanStep(derivePlanTasks(plan), STEP)
    expect(found?.step.kind).toBe('http')
    const owned = planScaffoldEntries(plan, found!.step)
    expect([owned.providers, owned.env, owned.config].map((elements) => elements.map((element) => element.id))).toEqual([['provider.reports'], ['env.reportsBucket'], ['config.queue']])
    expect(planScaffoldEntries(plan, { ...found!.step, kind: 'scaffold' })).toEqual({ providers: [], env: [], config: [] })
    const existing = PlanSchema.parse(document({ providers: [{ ...PROVIDER, change: { kind: 'existing' } }], env: [], config: [] }))
    expect(planScaffoldEntries(existing, found!.step).providers).toEqual([])
  })

  test('should write the provider as an empty class registered in createApp(), and the key in config/env.ts and .env.example', async () => {
    const { dir, plan } = await createApp()
    const report = await planScaffoldEntriesFile(plan, { appRoot: dir, step: STEP })

    expect(report.created).toEqual(['app/Providers/ReportsProvider.ts'])
    expect(await read(dir, 'app/Providers/ReportsProvider.ts')).toBe(providerTemplate('ReportsProvider'))
    expect(report.registered).toEqual({ file: 'src/app.ts', providers: ['ReportsProvider'] })
    const entry = await read(dir, 'src/app.ts')
    expect(entry).toContain("import ReportsProvider from '../app/Providers/ReportsProvider.js'")
    expect(entry).toMatch(/providers: \[\s*ReportsProvider,?\s*\]/u)

    expect(report.declared).toEqual({ file: 'config/env.ts', keys: ['REPORTS_BUCKET'], example: { file: '.env.example', keys: ['REPORTS_BUCKET'] } })
    const schema = await read(dir, 'config/env.ts')
    // What the lane reads back: the keys added and nothing else, each chain the one the plan states.
    expect(envKeyAdditions(ENV_SCHEMA, schema, 'config/env.ts')).toEqual(['REPORTS_BUCKET'])
    expect(schema).toContain("REPORTS_BUCKET: Env.string().default('reports').describe('Where reports are stored.')")
    expect(await read(dir, '.env.example')).toBe('APP_KEY=\n# Where reports are stored.\nREPORTS_BUCKET=reports\n')

    expect(report.left).toEqual([expect.objectContaining({ id: 'config.queue', section: 'config' })])
    const text = formatPlanScaffoldEntries(report, PLAN_FILE)
    expect(text).toContain('Registered in src/app.ts: ReportsProvider')
    expect(text).toContain('Declared in config/env.ts: REPORTS_BUCKET')
    expect(text).toContain(`bunx guren plan:verify ${PLAN_FILE} --step ${STEP}`)

    // A second run finds nothing left, which is how a re-run is refused.
    const again = await refusal(() => planScaffoldEntriesFile(plan, { appRoot: dir, step: STEP }))
    expect(again).toContain(`Nothing left to write for ${STEP}:`)
    expect(again).toContain('app/Providers/ReportsProvider.ts exists')
    expect(again).toEndWith('Nothing was written.')
  })

  test('should leave a provider or key a command wrote first, and write the rest', async () => {
    const schema = ENV_SCHEMA.replace('  APP_KEY: Env.string(),\n', "  APP_KEY: Env.string(),\n  REPORTS_BUCKET: Env.string().default('files'),\n")
    const { dir, plan } = await createApp({ files: { 'config/env.ts': schema } })
    const work = await planScaffoldEntriesWork(dir, PlanSchema.parse(document()), findPlanStep(derivePlanTasks(PlanSchema.parse(document())), STEP)!.step)
    expect([work.providers.map((provider) => provider.id), work.env.map((entry) => entry.id)]).toEqual([['provider.reports'], []])

    const report = await planScaffoldEntriesFile(plan, { appRoot: dir, step: STEP })
    expect(report.declared).toBeNull()
    expect(await read(dir, 'config/env.ts')).toBe(schema)
    expect(report.left.map((entry) => entry.id)).toEqual(['env.reportsBucket', 'config.queue'])

    const written = await createApp({ files: { 'app/Providers/ReportsProvider.js': 'export default class ReportsProvider {}\n', 'config/env.ts': schema } })
    const refused = await refusal(() => planScaffoldEntriesFile(written.plan, { appRoot: written.dir, step: STEP }))
    expect(refused).toContain('app/Providers/ReportsProvider.js exists, written by a command or by hand, so it is left as it is.')
    expect(refused).toContain('config/env.ts declares REPORTS_BUCKET already')
  })

  test('should refuse a step plan:next has not marked, and one that owns no entry', async () => {
    const unmarked = await createApp({ mark: null })
    expect(await refusal(() => planScaffoldEntriesFile(unmarked.plan, { appRoot: unmarked.dir, step: STEP }))).toContain(`${STEP} is not the step plan:next marked.`)

    const elsewhere = await createApp()
    expect(await refusal(() => planScaffoldEntriesFile(elsewhere.plan, { appRoot: elsewhere.dir, step: 'task/foundation/commands' }))).toContain(
      `task/foundation/commands is no step of the plan: --entries runs from the http step owning them: ${STEP}.`,
    )
  })

  test('should leave a provider it cannot register as plan:status reads it, and write the rest', async () => {
    const noEntry = await createApp({ files: { 'src/app.ts': null } })
    const unregistered = await planScaffoldEntriesFile(noEntry.plan, { appRoot: noEntry.dir, step: STEP })
    expect(unregistered.created).toEqual([])
    expect(unregistered.declared?.keys).toEqual(['REPORTS_BUCKET'])
    expect(unregistered.left[0]).toEqual({ id: 'provider.reports', section: 'providers', reason: 'this application has neither src/app.ts nor app.ts to register it in: write and register it by hand' })

    // A quoted key sets the option too, so no second `providers` key is composed beside it; the provider is left.
    const quoted = "import { createApp } from '@guren/core'\nimport A from '../app/Providers/A.js'\n\nexport default createApp({\n  'providers': [A],\n})\n"
    const twice = await createApp({ files: { 'src/app.ts': quoted } })
    const report = await planScaffoldEntriesFile(twice.plan, { appRoot: twice.dir, step: STEP })
    expect(report.created).toEqual([])
    expect(report.left[0]?.reason).toBe('Could not find the providers array: write and register it by hand')
    expect(await read(twice.dir, 'src/app.ts')).toBe(quoted)
  })

  test('should write a provider that shares its base class name, and leave one no class can be named', async () => {
    const named = (providers: Array<Record<string, unknown>>) => createApp({ plan: document({ providers, env: [], config: [] }) })
    const base = await named([{ ...PROVIDER, className: 'ServiceProvider' }])
    await planScaffoldEntriesFile(base.plan, { appRoot: base.dir, step: STEP })
    expect(await read(base.dir, 'app/Providers/ServiceProvider.ts')).toStartWith("import { ServiceProvider as BaseServiceProvider } from '@guren/core'\n\nexport default class ServiceProvider extends BaseServiceProvider {")

    const keyword = await named([{ ...PROVIDER, className: 'class' }])
    expect(await refusal(() => planScaffoldEntriesFile(keyword.plan, { appRoot: keyword.dir, step: STEP }))).toContain('provider.reports: class cannot name a class: rename it through plan:revise.')

    // One file holds both on a case-insensitive filesystem, so neither is written.
    const cased = await named([PROVIDER, { ...PROVIDER, id: 'provider.reports.again', className: 'Reportsprovider' }])
    const refused = await refusal(() => planScaffoldEntriesFile(cased.plan, { appRoot: cased.dir, step: STEP }))
    expect(refused).toContain('provider.reports: another provider of the step differs from ReportsProvider only by case')
    expect(refused).toContain('provider.reports.again: another provider of the step differs from Reportsprovider only by case')
  })

  test('should leave a key the writer cannot place in the defineEnv() literal the reader reads', async () => {
    const spaced = await createApp({ files: { 'config/env.ts': ENV_SCHEMA.replace('defineEnv({', 'defineEnv ({') } })
    const report = await planScaffoldEntriesFile(spaced.plan, { appRoot: spaced.dir, step: STEP })
    expect(report.created).toEqual(['app/Providers/ReportsProvider.ts'])
    expect(report.declared).toBeNull()
    expect(report.left[0]).toEqual({
      id: 'env.reportsBucket',
      section: 'env',
      reason: 'plan:scaffold cannot add REPORTS_BUCKET to the defineEnv() literal of config/env.ts alone (Could not find a defineEnv({ ... }) call): declare it there by hand',
    })
  })

  test('should leave a key it cannot declare to write by hand, and still write the provider', async () => {
    const noSchema = await createApp({ files: { 'config/env.ts': null } })
    const report = await planScaffoldEntriesFile(noSchema.plan, { appRoot: noSchema.dir, step: STEP })
    expect(report.created).toEqual(['app/Providers/ReportsProvider.ts'])
    expect(report.declared).toBeNull()
    expect(report.left[0]).toEqual({ id: 'env.reportsBucket', section: 'env', reason: 'config/env.ts does not exist, so plan:scaffold cannot add REPORTS_BUCKET to its defineEnv() literal: declare it there by hand' })

    const opaque = await createApp({ files: { 'config/env.ts': "import { defineEnv } from '@guren/core'\nimport { keys } from './keys'\n\nexport default defineEnv(keys)\n", 'app/Providers/ReportsProvider.ts': providerTemplate('ReportsProvider') } })
    const refused = await refusal(() => planScaffoldEntriesFile(opaque.plan, { appRoot: opaque.dir, step: STEP }))
    expect(refused).toContain(`Nothing left to write for ${STEP}:`)
    expect(refused).toContain("config/env.ts does not call the framework's defineEnv() once")
    expect(refused).toContain('declare it there by hand')
  })

  test('should declare a key as guren plugin does, keeping one the literal holds', () => {
    const base = "import { defineEnv } from '@guren/core'\n\nexport default defineEnv({\n  APP_KEY: Env.string(),\n})\n"
    const composed = composeEnvDeclarations(base, [planEnvEntry(ENV), { key: 'APP_KEY', default: 'x' }])
    if (typeof composed === 'string') throw new Error(composed)
    expect(composed.inserted).toEqual(['REPORTS_BUCKET'])
    expect(composed.content).toContain("import { Env, defineEnv } from '@guren/core'")
    expect(composed.content).toContain('  APP_KEY: Env.string(),')
    const value = envKeyValue(composed.content, 'config/env.ts', 'REPORTS_BUCKET')
    expect(value && envBuilderSignature(value)).toBe(plannedEnvSignature(planEnvEntry(ENV)))
    expect(composeEnvDeclarations(base, [{ key: 'APP_KEY', default: 'x' }])).toEqual({ content: base, inserted: [] })
    expect(composeEnvDeclarations('export default {}\n', [planEnvEntry(ENV)])).toBeTypeOf('string')
  })
})
