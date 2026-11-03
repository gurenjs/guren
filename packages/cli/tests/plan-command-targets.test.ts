import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { readdir, rm } from 'node:fs/promises'
import { basename, join } from 'node:path'

import { builtinSubCommands } from '../src/commands'
import { makeAuth, type MakeAuthOptions } from '../src/make-auth'
import { planApproveFile } from '../src/plan-approve'
import { planGeneratorNames } from '../src/plan/command-allowlist'
import { PLAN_GENERATOR_TARGETS, readPlanGeneratorCall, type PlanGeneratorRule } from '../src/plan/command-targets'
import { PlanDraftSchema } from '../src/plan/schema'
import { validatePlan } from '../src/plan/validate'
import { resolveValue } from '../src/run-cli'
import { createTempRoot, createTempWorkspace, writeWorkspaceFiles } from './helpers'
import { loadCommentsPlan, PLAN_APP_FILES, planAppState } from './plan-fixture'

type ArgDefinition = { type?: string; alias?: string | string[] }

/** The registry's own reading of a generator: whether it takes a positional, and which flags take a value. */
async function registryArgs(name: string): Promise<{ positional: boolean; valueFlags: string[] }> {
  const [head, member] = name.split(' ')
  let command = (await resolveValue(builtinSubCommands[head as keyof typeof builtinSubCommands])) as { args?: unknown; subCommands?: unknown }
  if (member !== undefined) {
    const members = (await resolveValue(command.subCommands as never)) as Record<string, unknown>
    command = (await resolveValue(members[member] as never)) as typeof command
  }
  const args = ((await resolveValue(command.args as never)) ?? {}) as Record<string, ArgDefinition>
  const definitions = Object.entries(args)
  return {
    positional: definitions.some(([, definition]) => definition.type === 'positional'),
    valueFlags: definitions
      .filter(([, definition]) => definition.type === 'string')
      .flatMap(([key, definition]) => [key, ...[definition.alias ?? []].flat()])
      .sort(),
  }
}

const rule = (name: string): PlanGeneratorRule => PLAN_GENERATOR_TARGETS[name] as PlanGeneratorRule

function commandFindings(command: string, plan: Record<string, unknown> = loadCommentsPlan(), app = planAppState()) {
  const parsed = PlanDraftSchema.parse({ ...plan, commands: [{ id: 'command.x', command, reason: 'Set up first.' }] })
  return validatePlan(parsed, app).filter((result) => result.key.startsWith('plan:command'))
}

const messageOf = (command: string, plan?: Record<string, unknown>, app?: ReturnType<typeof planAppState>): string | undefined =>
  commandFindings(command, plan, app).find((result) => result.key === 'plan:command-target')?.message

type PlanDocument = Record<string, unknown> & { models: Array<Record<string, unknown>>; controllers: unknown[]; policies: unknown[] }
const commentsPlan = (): PlanDocument => loadCommentsPlan() as PlanDocument

const SCAFFOLD = 'task/entity/model.comment/scaffold'
const REFUSES = `which plan:scaffold writes at step ${SCAFFOLD}, refusing a target that already exists`
const FAILS_TYPECHECK = 'so the commands step (task/foundation/commands) fails its typecheck'

describe('the generator table', () => {
  test('should decide every generator the allowlist allows, and name nothing else', () => {
    expect(Object.keys(PLAN_GENERATOR_TARGETS).sort()).toEqual(planGeneratorNames().sort())
  })

  test('should read each generator with the positional and value flags the registry declares', async () => {
    const mismatches: string[] = []
    for (const [name, entry] of Object.entries(PLAN_GENERATOR_TARGETS)) {
      if (typeof entry === 'string') continue
      const registry = await registryArgs(name)
      if (registry.positional !== entry.positional) mismatches.push(`${name}: positional ${entry.positional}, registry ${registry.positional}`)
      if (JSON.stringify([...entry.valueFlags].sort()) !== JSON.stringify(registry.valueFlags)) {
        mismatches.push(`${name}: value flags ${[...entry.valueFlags].sort().join(',')}, registry ${registry.valueFlags.join(',')}`)
      }
    }
    expect(mismatches).toEqual([])
  })
})

describe('readPlanGeneratorCall', () => {
  test('should take the word after a value flag as its value, not as the positional', () => {
    expect(readPlanGeneratorCall(rule('make:factory'), ['--model', 'Comment', 'CommentSeedFactory'])).toEqual({
      name: 'CommentSeedFactory',
      flags: new Map([['model', 'Comment']]),
    })
  })

  test('should read a value written after "=" and a single-dash alias', () => {
    expect(readPlanGeneratorCall(rule('make:resource'), ['-m', 'Comment', 'Feed', '--module=billing'])).toEqual({
      name: 'Feed',
      flags: new Map([['m', 'Comment'], ['module', 'billing']]),
    })
  })

  test('should leave the word after a boolean flag as the positional', () => {
    expect(readPlanGeneratorCall(rule('make:feature'), ['--policy', 'Comment'])).toEqual({ name: 'Comment', flags: new Map([['policy', true]]) })
  })

  test('should place nothing when a value flag ends the command or the positional is missing', () => {
    expect(readPlanGeneratorCall(rule('make:factory'), ['CommentFactory', '--model'])).toBeUndefined()
    expect(readPlanGeneratorCall(rule('make:model'), ['--force'])).toBeUndefined()
  })
})

describe('the §2 check', () => {
  test('should fail a generator writing a model the plan adds, naming the scaffold step', () => {
    expect(commandFindings('guren make:model Comment')).toEqual([
      expect.objectContaining({
        key: 'plan:command-target',
        status: 'fail',
        title: 'Plan commands',
        elementId: 'command.x',
        section: 'commands',
        message: `The command "guren make:model Comment" runs before the steps that build what the plan adds: it writes model Comment (model.comment), ${REFUSES}.`,
      }),
    ])
  })

  test('should fail a factory importing a model the plan adds, as a typecheck the commands step fails', () => {
    const imports = `it imports model Comment (model.comment), which step ${SCAFFOLD} writes, ${FAILS_TYPECHECK}.`
    expect(messageOf('guren make:factory CommentFactory')).toEndWith(imports)
    expect(messageOf('guren make:factory --model Comment CommentSeedFactory')).toEndWith(imports)
    expect(messageOf('guren make:factory PostFactory')).toBeUndefined()
  })

  test('should name both what a resource writes and the model it imports', () => {
    expect(messageOf('guren make:resource CommentResource')).toBe(
      'The command "guren make:resource CommentResource" runs before the steps that build what the plan adds: '
      + `it writes resource CommentResource (resource.comment), ${REFUSES}; `
      + `it imports model Comment (model.comment), which step ${SCAFFOLD} writes, ${FAILS_TYPECHECK}.`,
    )
  })

  test('should list every element make:feature writes that the plan adds', () => {
    expect(messageOf('bunx guren make:feature Comment --fields "body:text"')).toBe(
      'The command "bunx guren make:feature Comment --fields \\"body:text\\"" runs before the steps that build what the plan adds: '
      + 'it writes model Comment (model.comment), controller CommentController (controller.comments), resource CommentResource (resource.comment) '
      + `and validator CommentPayloadSchema (validator.comment), ${REFUSES}.`,
    )
  })

  test.each([
    ['guren make:validator Comment', 'validator CommentPayloadSchema (validator.comment)'],
    ['guren make:policy Comment', 'policy CommentPolicy (policy.comment)'],
    ['guren make:controller CommentController', 'controller CommentController (controller.comments)'],
    ['guren make:provider CommentPolicy', 'the provider CommentPolicyProvider of policy CommentPolicy (policy.comment)'],
    ['guren make:feature Comment --prototype', 'validator CommentPayloadSchema (validator.comment)'],
    ['guren add resource comments', 'model Comment (model.comment), controller CommentController (controller.comments), resource CommentResource (resource.comment) and validator CommentPayloadSchema (validator.comment)'],
    ['guren make:route comments', 'route comments.store (route.comments.store) and route comments.destroy (route.comments.destroy)'],
  ])('should fail %j for what it writes', (command, written) => {
    expect(messageOf(command)).toContain(`it writes ${written}, ${REFUSES}`)
  })

  test.each([
    ['an allowed generator writing nothing the plan adds', 'guren add attachments'],
    ['a model the plan only alters', 'guren make:model Post'],
    ['a model the plan does not declare', 'guren make:model Tag'],
    ['another module than the element', 'guren make:model Comment --module billing'],
    ['a class name the generator spells differently', 'guren make:controller Comments'],
  ])('should pass %s', (_, command) => {
    expect(commandFindings(command)).toEqual([])
  })

  test('should fail a blueprint writing the table of a model the plan adds, whatever root the model sits in', () => {
    const plan = commentsPlan()
    const session = { id: 'model.session', change: { kind: 'add' }, name: 'Session', table: 'sessions', columns: [], relationships: [], fillable: [] }

    const root = { ...plan, models: [...plan.models, session] }
    expect(messageOf('guren add session', root)).toEndWith('it writes table sessions of model Session (model.session), which plan:scaffold writes at step task/entity/model.session/scaffold, refusing a target that already exists.')
    expect(messageOf('guren make:auth', root)).toContain('it writes table sessions of model Session (model.session)')
    expect(messageOf('guren make:auth --no-session', root)).toBeUndefined()

    const inModule = { ...plan, models: [...plan.models, { ...session, module: 'accounts' }] }
    expect(messageOf('guren add session', inModule)).toEndWith(
      'it declares table sessions of model Session (model.session) in db/schema.ts and generates a migration for it, before step task/entity/model.session/data declares that table.',
    )
  })

  test('should name a migration only for a blueprint that generates one', () => {
    const plan = commentsPlan()
    const attachment = { id: 'model.attachment', change: { kind: 'add' }, name: 'Attachment', table: 'attachments', module: 'media', columns: [], relationships: [], fillable: [] }
    expect(messageOf('guren add attachments', { ...plan, models: [...plan.models, attachment] })).toEndWith(
      'it declares table attachments of model Attachment (model.attachment) in db/schema.ts, before step task/entity/model.attachment/data declares that table.',
    )
  })

  test("should match make:auth's validator exports against a validator plan:scaffold writes", () => {
    const plan = commentsPlan() as PlanDocument & { validators: unknown[]; tasks: Array<{ covers: string[] }> }
    const login = { id: 'validator.login', change: { kind: 'add' }, name: 'LoginSchema', fields: [] }
    const covered = plan.tasks.map((task, index) => (index === 0 ? { ...task, covers: [...task.covers, 'validator.login'] } : task))
    expect(messageOf('guren make:auth', { ...plan, validators: [...plan.validators, login], tasks: covered })).toEndWith(`it writes validator LoginSchema (validator.login), ${REFUSES}.`)
  })

  test('should judge a renamed model and a renamed table by the name they take, which is absent when the plan starts', () => {
    const plan = commentsPlan()
    const renamed = { ...plan, models: plan.models.map((model) => (model.id === 'model.post' ? { ...model, change: { kind: 'rename', from: 'Post' }, name: 'Article' } : model)) }
    expect(messageOf('guren make:factory ArticleFactory', renamed)).toEndWith(`it imports model Article (model.post), which step task/entity/model.post/data writes, ${FAILS_TYPECHECK}.`)

    const intoSessions = {
      ...plan,
      models: plan.models.map((model) => (model.id === 'model.post' ? { ...model, tableRenamedFrom: 'posts', table: 'sessions', dataMigration: { kind: 'none', reason: 'Renamed in place.' } } : model)),
    }
    expect(messageOf('guren add session', intoSessions)).toContain('it declares table sessions of model Post (model.post) in db/schema.ts and generates a migration for it')
  })

  test('should fail a model no scaffold writes only for the db/schema export it imports before anything declares it', () => {
    const apiOnly = planAppState({ apiOnly: true })
    expect(messageOf('guren make:model Comment', undefined, apiOnly)).toEndWith(
      `it writes model Comment (model.comment) importing \`comments\` from db/schema, which does not declare it yet, ${FAILS_TYPECHECK}.`,
    )
    expect(messageOf('guren make:factory CommentFactory', undefined, apiOnly)).toEndWith(`it imports model Comment (model.comment), which step task/entity/model.comment/data writes, ${FAILS_TYPECHECK}.`)
  })

  test('should fail a controller no scaffold writes only for a page it renders that the application lacks', () => {
    const plan = commentsPlan()
    const withReports = { ...plan, controllers: [...plan.controllers, { id: 'controller.reports', change: { kind: 'add' }, className: 'ReportController', actions: [] }] }
    expect(messageOf('guren make:controller Report', withReports)).toEndWith(
      `it writes controller ReportController (controller.reports) rendering the page report/Index, which the application does not have, ${FAILS_TYPECHECK}.`,
    )
    expect(messageOf('guren make:controller Report', withReports, planAppState({ pages: ['posts/Index', 'report/Index'] }))).toBeUndefined()
    expect(messageOf('guren make:controller Report', withReports, planAppState({ apiOnly: true }))).toBeUndefined()
  })

  test('should pass a stub no scaffold writes and nothing imports, which the step that owns it edits', () => {
    const plan = commentsPlan()
    const job = { id: 'effect.digest', change: { kind: 'add' }, kind: 'job', name: 'SendDigestJob', trigger: 'nightly', description: 'Sends the digest.' }
    expect(messageOf('guren make:job SendDigest', { ...plan, sideEffects: [job] })).toBeUndefined()

    const postPolicy = { id: 'policy.post', change: { kind: 'add' }, name: 'PostPolicy', model: 'model.post', abilities: [{ name: 'update', rule: 'the author' }] }
    expect(messageOf('guren make:policy Post', { ...plan, policies: [...plan.policies, postPolicy] })).toBeUndefined()

    const apiOnly = planAppState({ apiOnly: true })
    expect(messageOf('guren make:policy Comment', undefined, apiOnly)).toBeUndefined()
    expect(messageOf('guren make:controller CommentController', undefined, apiOnly)).toBeUndefined()
  })

  test('should leave a command the allowlist refuses to plan:command alone', () => {
    expect(commandFindings('bun run db:migrate').map((result) => result.key)).toEqual(['plan:command'])
  })

  test('should match a module element by its module, and judge a model plan:scaffold leaves to its step by the schema it imports', () => {
    const plan = commentsPlan()
    const inModule = { ...plan, models: plan.models.map((model) => (model.id === 'model.comment' ? { ...model, module: 'billing' } : model)) }
    const written = `it writes model Comment (model.comment) importing \`comments\` from db/schema, which does not declare it yet, ${FAILS_TYPECHECK}.`

    expect(messageOf('guren make:model Comment --module billing', inModule)).toEndWith(written)
    expect(messageOf('guren make:model Comment -M Billing', inModule)).toEndWith(written)
    expect(messageOf('guren make:model Comment', inModule)).toBeUndefined()
  })
})

describe("make:auth's targets", () => {
  const AUTH_APP = {
    'src/app.ts': "import { createApp } from '@guren/core'\nimport registerWebRoutes from '../routes/web.js'\n\nconst app = createApp({ routes: registerWebRoutes, providers: [] })\n\nexport default app\n",
    'routes/web.ts': "import { Router } from '@guren/core'\n\nexport function registerWebRoutes(router: Router): void {\n  router.get('/', () => 'home')\n}\n",
    'resources/js/pages/Home.tsx': 'export default function Home() { return <h1>home</h1> }\n',
    'db/schema.ts': "export const posts = 'posts'\n",
  }

  function written(created: readonly string[]): Record<string, string[]> {
    const pick = (pattern: RegExp): string[] => created.flatMap((path) => pattern.exec(path)?.slice(1, 2) ?? []).sort()
    const schemas = created
      .filter((path) => path.includes('/app/Http/Validators/'))
      .flatMap((path) => [...readFileSync(path, 'utf8').matchAll(/^export const (\w+)/gmu)].map((match) => `${basename(path)}#${match[1]}`))
    return {
      models: pick(/\/app\/Models\/(\w+)\.ts$/),
      controllers: pick(/\/app\/Http\/Controllers\/(?:\w+\/)*(\w+)\.ts$/),
      mails: pick(/\/app\/Mail\/(\w+)\.ts$/),
      validators: schemas.sort(),
    }
  }

  function planned(args: string[]): Record<string, string[]> {
    const { writes } = rule('make:auth').targets(readPlanGeneratorCall(rule('make:auth'), args)!)
    const names = (keep: (target: (typeof writes)[number]) => boolean): string[] =>
      writes.filter(keep).flatMap((target) => ('names' in target ? [...target.names] : [])).sort()
    return {
      models: names((target) => target.section === 'models'),
      controllers: names((target) => target.section === 'controllers'),
      mails: names((target) => target.section === 'sideEffects' && target.kind === 'mail'),
      validators: writes.flatMap((target) => (target.section === 'validators' ? target.exports.map((name) => `${basename(target.file)}#${name}`) : [])).sort(),
    }
  }

  test.each([
    [[], {}],
    [['--minimal'], { minimal: true }],
    [['--verify'], { verify: true }],
    [['--oauth', 'github'], { oauth: 'github' }],
    [['--oauth', 'github', '--oauth-only'], { oauth: 'github', oauthOnly: true }],
  ] as Array<[string[], MakeAuthOptions]>)('should name the classes and validator schemas make:auth %j writes', async (args, options) => {
    const workspace = await createTempWorkspace('guren-plan-command-targets-auth-')
    try {
      await writeWorkspaceFiles(workspace.dir, AUTH_APP)
      const created = await makeAuth({ ...options, force: true, session: false })
      expect(planned(args)).toEqual(written(created))
    } finally {
      await workspace.cleanup()
    }
  })
})

describe('plan:approve', () => {
  let ROOT: string
  beforeAll(async () => {
    ROOT = await createTempRoot('guren-plan-command-targets-')
  })
  afterAll(async () => {
    await rm(ROOT, { recursive: true, force: true })
  })

  function git(dir: string, ...args: string[]): void {
    const result = Bun.spawnSync(['git', '-c', 'user.name=Approver', '-c', 'user.email=approver@example.com', ...args], { cwd: dir, stdout: 'pipe', stderr: 'pipe' })
    if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr.toString()}`)
  }

  test('should refuse a plan whose command writes an element the plan adds', async () => {
    const app = join(ROOT, 'approve')
    const command = { id: 'command.model', command: 'guren make:model Comment', reason: 'The model first.' }
    await writeWorkspaceFiles(app, { ...PLAN_APP_FILES, 'comments.plan.json': JSON.stringify({ ...loadCommentsPlan(), questions: [], commands: [command] }) })
    git(app, 'init', '-q')
    git(app, 'add', '-A')
    git(app, 'commit', '-q', '-m', 'init')

    await expect(planApproveFile(join(app, 'comments.plan.json'), { app: planAppState(), appRoot: app })).rejects.toThrow(
      /command\.model: The command "guren make:model Comment" runs before the steps that build what the plan adds/,
    )
    expect(await readdir(app)).not.toContain('comments.approvals.json')
  })
})
