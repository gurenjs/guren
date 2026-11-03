import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

import { builtinSubCommands } from '../src/commands'
import { planApproveFile } from '../src/plan-approve'
import { planGeneratorNames } from '../src/plan/command-allowlist'
import { PLAN_GENERATOR_TARGETS, readPlanGeneratorCall, type PlanGeneratorRule } from '../src/plan/command-targets'
import { PlanDraftSchema } from '../src/plan/schema'
import { validatePlan } from '../src/plan/validate'
import { resolveValue } from '../src/run-cli'
import { createTempRoot, writeWorkspaceFiles } from './helpers'
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

function commandFindings(command: string, plan: Record<string, unknown> = loadCommentsPlan()) {
  const parsed = PlanDraftSchema.parse({ ...plan, commands: [{ id: 'command.x', command, reason: 'Set up first.' }] })
  return validatePlan(parsed, planAppState()).filter((result) => result.key.startsWith('plan:command'))
}

const messageOf = (command: string): string | undefined => commandFindings(command).find((result) => result.key === 'plan:command-target')?.message

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
    const plan = loadCommentsPlan() as { models: unknown[] }
    const session = { id: 'model.session', change: { kind: 'add' }, name: 'Session', table: 'sessions', columns: [], relationships: [], fillable: [] }
    const target = (command: string, models: unknown[]) =>
      commandFindings(command, { ...plan, models }).find((result) => result.key === 'plan:command-target')?.message

    const root = [...plan.models, session]
    expect(target('guren add session', root)).toEndWith('it writes table sessions of model Session (model.session), which plan:scaffold writes at step task/entity/model.session/scaffold, refusing a target that already exists.')
    expect(target('guren make:auth', root)).toContain('it writes table sessions of model Session (model.session)')
    expect(target('guren make:auth --no-session', root)).toBeUndefined()

    const inModule = [...plan.models, { ...session, module: 'accounts' }]
    expect(target('guren add session', inModule)).toEndWith('it writes table sessions of model Session (model.session), which step task/entity/model.session/data writes.')
  })

  test('should leave a command the allowlist refuses to plan:command alone', () => {
    expect(commandFindings('bun run db:migrate').map((result) => result.key)).toEqual(['plan:command'])
  })

  test('should match a module element by its module, and name its owning step, since plan:scaffold writes the root only', () => {
    const plan = loadCommentsPlan() as { models: Array<{ id: string }> }
    const inModule = { ...plan, models: plan.models.map((model) => (model.id === 'model.comment' ? { ...model, module: 'billing' } : model)) }
    const written = 'it writes model Comment (model.comment), which step task/entity/model.comment/data writes.'

    expect(commandFindings('guren make:model Comment --module billing', inModule).find((result) => result.key === 'plan:command-target')?.message).toEndWith(written)
    expect(commandFindings('guren make:model Comment -M Billing', inModule).find((result) => result.key === 'plan:command-target')?.message).toEndWith(written)
    expect(commandFindings('guren make:model Comment', inModule).filter((result) => result.key === 'plan:command-target')).toEqual([])
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
