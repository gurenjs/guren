/**
 * What each generator a plan's `commands` may run writes or imports, by plan section (RFC 0030 §2).
 * The commands run first, in Foundation: one writing an element the plan adds collides with the
 * step that writes it (`plan:scaffold` refuses a target that exists), and one importing such an
 * element fails the commands step's typecheck. Names come from the generators' own helpers.
 * `tests/plan-command-targets.test.ts` holds the table to the allowlist and the flags to the registry.
 */

import { singularize, tableNameFor } from '../inflect'
import { routeFile, routeGroupController } from '../make-route'
import { validatorFile, validatorSchemaNames } from '../make-validator'
import { ensureSuffix, kebabCase, pascalCase } from '../utils'
import { judgePlanCommand, quotePlanCommand } from './command-allowlist'
import { planScaffoldCoverage, planScaffoldMounts } from './scaffold'
import { validatorFilePath } from './scaffold-http'
import type { PlanDraft, PlanSideEffect } from './schema'
import type { PlanTaskDerivation } from './tasks'

type ClassSection = 'models' | 'controllers' | 'resources' | 'policies'

export type PlanGeneratorTarget =
  | { section: ClassSection; names: readonly string[] }
  | { section: 'sideEffects'; kind: PlanSideEffect['kind']; names: readonly string[] }
  /** A policy's provider, `<Policy>Provider`, which `plan:scaffold` writes beside the policy. */
  | { section: 'policyProviders'; names: readonly string[] }
  /** `app/Http/Validators/<entity>Validator.ts` with `make:validator`'s three schemas. */
  | { section: 'validators'; entity: string }
  /** An app-relative routes file. */
  | { section: 'routes'; file: string }
  /** SQL table names, which collide with an added model's `table` in any root. */
  | { section: 'tables'; names: readonly string[] }

export interface PlanGeneratorTargets {
  writes: PlanGeneratorTarget[]
  imports: PlanGeneratorTarget[]
}

export interface PlanGeneratorCall {
  /** The positional argument, absent for a generator that takes none. */
  name?: string
  flags: ReadonlyMap<string, string | true>
}

export interface PlanGeneratorRule {
  /** Every flag the registry declares as taking a value, aliases included: the word after one is its value. */
  valueFlags: readonly string[]
  positional: boolean
  targets(call: PlanGeneratorCall): PlanGeneratorTargets
}

const MODULE = ['module', 'M']

const writes = (...targets: PlanGeneratorTarget[]): PlanGeneratorTargets => ({ writes: targets, imports: [] })
const className = (name: string): string => pascalCase(name)
const suffixed = (name: string, suffix: string): string => ensureSuffix(className(name), suffix)
const unsuffixed = (name: string, suffix: string): string => suffixed(name, suffix).slice(0, -suffix.length)
const flagOn = (call: PlanGeneratorCall, flag: string): boolean => call.flags.get(flag) === true || call.flags.get(flag) === 'true'
const sideEffect = (kind: PlanSideEffect['kind'], ...names: string[]): PlanGeneratorTarget => ({ section: 'sideEffects', kind, names })

function classRule(section: ClassSection, suffix?: string): PlanGeneratorRule {
  return {
    valueFlags: MODULE,
    positional: true,
    targets: ({ name }) => writes({ section, names: [suffix ? suffixed(name!, suffix) : className(name!)] }),
  }
}

function sideEffectRule(kind: PlanSideEffect['kind'], suffix?: string): PlanGeneratorRule {
  return { valueFlags: MODULE, positional: true, targets: ({ name }) => writes(sideEffect(kind, suffix ? suffixed(name!, suffix) : className(name!))) }
}

/** `make:feature` and `add resource` without `--prototype`; `make:feature --policy` adds the policy. */
function featureTargets(singular: string, policy: boolean): PlanGeneratorTargets {
  return writes(
    { section: 'models', names: [singular] },
    { section: 'controllers', names: [`${singular}Controller`] },
    { section: 'resources', names: [`${singular}Resource`] },
    { section: 'validators', entity: singular },
    ...(policy ? [{ section: 'policies' as const, names: [`${singular}Policy`] }] : []),
  )
}

/** `make:auth` writes `sessions` through `add session` unless `--no-session`, and `oauth_states` with `--oauth`. */
function authTargets(call: PlanGeneratorCall): PlanGeneratorTargets {
  const tables = ['users', ...(call.flags.get('no-session') === true ? [] : ['sessions']), ...(typeof call.flags.get('oauth') === 'string' ? ['oauth_states'] : [])]
  return writes(
    { section: 'models', names: ['User'] },
    { section: 'controllers', names: ['LoginController', 'DashboardController', 'ProfileController'] },
    { section: 'tables', names: tables },
  )
}

/** Total over `planGeneratorNames()`: a string is why the generator is not judged. */
export const PLAN_GENERATOR_TARGETS: Readonly<Record<string, PlanGeneratorRule | string>> = Object.assign(Object.create(null), {
  'make:controller': classRule('controllers', 'Controller'),
  'make:model': classRule('models'),
  'make:view': 'a page, which no scaffold writes; its template imports only Inertia and React, so the pages step edits it in place',
  'make:route': {
    valueFlags: MODULE,
    positional: true,
    targets: ({ name }) => ({
      writes: [{ section: 'routes', file: routeFile(name!).path }],
      imports: [{ section: 'controllers', names: [routeGroupController(className(name!))] }],
    }),
  },
  'make:job': sideEffectRule('job', 'Job'),
  'make:event': sideEffectRule('event'),
  'make:mail': sideEffectRule('mail', 'Mail'),
  'make:middleware': 'a middleware, which no plan section declares',
  'make:policy': classRule('policies', 'Policy'),
  'make:seeder': 'a seeder, which no plan section declares',
  'make:notification': sideEffectRule('notification', 'Notification'),
  'make:provider': { valueFlags: MODULE, positional: true, targets: ({ name }) => writes({ section: 'policyProviders', names: [suffixed(name!, 'Provider')] }) },
  'make:adr': 'a decision record, which no plan section declares',
  'make:validator': { valueFlags: ['fields', 'F', ...MODULE], positional: true, targets: ({ name }) => writes({ section: 'validators', entity: unsuffixed(name!, 'Validator') }) },
  'make:agent': 'a durable agent, which no plan section declares',
  'make:ai-agent': 'an in-process agent, which no plan section declares',
  'make:module': 'a module skeleton, which elements in that module need before any step writes them',
  'make:channel': 'a broadcast channel, which no plan section declares',
  'make:command': 'a console command, which no plan section declares',
  'make:exception': 'an exception class, which no plan section declares',
  'make:factory': {
    valueFlags: ['model', 'm', ...MODULE],
    positional: true,
    targets: ({ name, flags }) => {
      const model = flags.get('model') ?? flags.get('m')
      return { writes: [], imports: [{ section: 'models', names: [typeof model === 'string' ? model : unsuffixed(name!, 'Factory')] }] }
    },
  },
  'make:listener': {
    valueFlags: ['event', 'e', ...MODULE],
    positional: true,
    targets: ({ name, flags }) => {
      const event = flags.get('event') ?? flags.get('e')
      return { writes: [sideEffect('listener', suffixed(name!, 'Listener'))], imports: typeof event === 'string' ? [sideEffect('event', className(event))] : [] }
    },
  },
  'make:resource': {
    valueFlags: ['model', 'm', ...MODULE],
    positional: true,
    targets: ({ name, flags }) => {
      const model = flags.get('model') ?? flags.get('m')
      return {
        writes: [{ section: 'resources', names: [suffixed(name!, 'Resource')] }],
        imports: [{ section: 'models', names: [typeof model === 'string' ? model : unsuffixed(name!, 'Resource')] }],
      }
    },
  },
  'make:test': 'a test file, which imports no element',
  'make:lang': 'a translation catalog, which no plan section declares',
  'make:feature': {
    valueFlags: ['fields', 'F', 'attach', ...MODULE],
    positional: true,
    targets: (call) => {
      const singular = className(call.name!)
      return flagOn(call, 'prototype') ? writes({ section: 'validators', entity: singular }) : featureTargets(singular, flagOn(call, 'policy'))
    },
  },
  'lang:publish': "the framework's translation catalogs, which no plan section declares",
  'add admin': { valueFlags: [], positional: false, targets: () => writes({ section: 'controllers', names: ['AdminDashboardController'] }) },
  'add attachments': { valueFlags: [], positional: false, targets: () => writes({ section: 'tables', names: ['attachments'] }) },
  'add broadcasting': 'broadcast channels and their provider, which no plan section declares',
  'add cache': 'the cache config and a cache service, which no plan section declares',
  'add events': { valueFlags: [], positional: false, targets: () => writes(sideEffect('event', 'OrderPlaced'), sideEffect('listener', 'SendOrderReceiptListener')) },
  'add lint': 'the lint config and scripts, which no plan section declares',
  'add mail': { valueFlags: [], positional: false, targets: () => writes(sideEffect('mail', 'WelcomeEmailMail')) },
  'add notifications': { valueFlags: [], positional: false, targets: () => writes(sideEffect('notification', 'WelcomeUserNotification')) },
  'add queue': { valueFlags: [], positional: false, targets: () => writes(sideEffect('job', 'ProcessWelcomeSequenceJob')) },
  'add resource': {
    valueFlags: ['fields', 'F', 'attach'],
    positional: true,
    targets: ({ name }) => {
      const singular = singularize(className(name!))
      const feature = featureTargets(singular, false)
      return { ...feature, writes: [...feature.writes, { section: 'tables', names: [tableNameFor(singular)] }] }
    },
  },
  'add prototype': 'the prototype fixture and its wiring, which no plan section declares',
  'add schedule': 'the schedule kernel and its provider, which no plan section declares',
  'add storage': 'the storage config and a storage service, which no plan section declares',
  'add ui': 'UI components, which no plan section declares',
  'make:auth': { valueFlags: ['oauth'], positional: false, targets: authTargets },
  'add auth': { valueFlags: [], positional: false, targets: authTargets },
  'add oauth': {
    valueFlags: [],
    positional: false,
    targets: () => writes({ section: 'controllers', names: ['OAuthController'] }, { section: 'tables', names: ['oauth_states'] }),
  },
  'add session': { valueFlags: [], positional: false, targets: () => writes({ section: 'tables', names: ['sessions'] }) },
  'add ai': {
    valueFlags: ['provider'],
    positional: false,
    targets: (call) => (call.flags.get('no-conversations') === true ? writes() : writes({ section: 'tables', names: ['ai_conversations', 'ai_messages'] })),
  },
} satisfies Record<string, PlanGeneratorRule | string>)

/** The positional and flags as the registry's parser reads them; `undefined` when a word cannot be placed. */
export function readPlanGeneratorCall(rule: PlanGeneratorRule, args: readonly string[]): PlanGeneratorCall | undefined {
  const flags = new Map<string, string | true>()
  const positionals: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const word = args[index]!
    if (!word.startsWith('-')) {
      positionals.push(word)
      continue
    }
    const body = word.replace(/^--?/u, '')
    const equals = body.indexOf('=')
    if (equals !== -1) {
      flags.set(body.slice(0, equals), body.slice(equals + 1))
    } else if (rule.valueFlags.includes(body)) {
      const value = args[index + 1]
      if (value === undefined) return undefined
      flags.set(body, value)
      index += 1
    } else {
      flags.set(body, true)
    }
  }
  if (!rule.positional) return { flags }
  const [name] = positionals
  return name === undefined || name === '' ? undefined : { name, flags }
}

export interface PlanCommandTargetHit {
  effect: 'writes' | 'imports'
  elementId: string
  /** What the element is and its name, as a message names it: `model Comment`. */
  label: string
  /** The step that writes the element, and whether `plan:scaffold` writes it there. */
  step: { id: string; scaffold: boolean } | undefined
}

export interface PlanCommandTargets {
  id: string
  quoted: string
  hits: PlanCommandTargetHit[]
}

interface Added {
  id: string
  module?: string
  label: string
}

const sameModule = (element: { module?: string }, module: string | undefined): boolean =>
  (element.module === undefined ? undefined : kebabCase(element.module)) === module

/**
 * Every allowed command whose generator writes or imports an element the plan adds, in command
 * order. A word the reader cannot place, or a rule naming nothing, contributes no hit.
 */
export function planCommandTargets(plan: PlanDraft, derivation: () => PlanTaskDerivation): PlanCommandTargets[] {
  const read = plan.commands.flatMap((command) => {
    const verdict = judgePlanCommand(command.command)
    const rule = verdict.allowed ? PLAN_GENERATOR_TARGETS[verdict.subcommand] : undefined
    if (!verdict.allowed || rule === undefined || typeof rule === 'string') return []
    const call = readPlanGeneratorCall(rule, verdict.args)
    if (call === undefined) return []
    const module = call.flags.get('module') ?? call.flags.get('M')
    return [{ command, call, targets: rule.targets(call), module: typeof module === 'string' ? kebabCase(module) : undefined }]
  })
  if (read.length === 0) return []

  const tasks = derivation()
  const index = indexAdded(plan, tasks)
  return read.flatMap(({ command, targets, module }) => {
    const hits = new Map<string, PlanCommandTargetHit>()
    for (const [effect, list] of [['writes', targets.writes], ['imports', targets.imports]] as const) {
      for (const target of list) {
        for (const element of index.match(target, module)) {
          if (!hits.has(element.id)) hits.set(element.id, { effect, elementId: element.id, label: element.label, step: index.writer(element) })
        }
      }
    }
    return hits.size > 0 ? [{ id: command.id, quoted: quotePlanCommand(command.command), hits: [...hits.values()] }] : []
  })
}

function indexAdded(plan: PlanDraft, derivation: PlanTaskDerivation) {
  const added = <T extends { change: { kind: string } }>(elements: readonly T[]): T[] => elements.filter((element) => element.change.kind === 'add')
  const classes: Record<ClassSection, Array<Added & { name: string }>> = {
    models: added(plan.models).map((model) => ({ id: model.id, module: model.module, name: model.name, label: `model ${model.name}` })),
    controllers: added(plan.controllers).map((controller) => ({ id: controller.id, module: controller.module, name: controller.className, label: `controller ${controller.className}` })),
    resources: added(plan.resources).map((resource) => ({ id: resource.id, module: resource.module, name: resource.name, label: `resource ${resource.name}` })),
    policies: added(plan.policies).map((policy) => ({ id: policy.id, module: policy.module, name: policy.name, label: `policy ${policy.name}` })),
  }
  const effects = added(plan.sideEffects)
  const validators = added(plan.validators)
  const routes = new Map(added(plan.routes).map((route) => [route.id, route]))

  const tables = added(plan.models).map((model) => ({ id: model.id, module: model.module, table: model.table, label: `table ${model.table} of model ${model.name}` }))

  /** `plan:scaffold` writes to the project root only, so a module's element is its owning step's. */
  const scaffolded = new Map<string, string>()
  const owned = new Map<string, string>()
  /** Validator file → the validators a scaffold step writes into it. */
  const validatorFiles = new Map<string, string[]>()
  for (const task of derivation.tasks) {
    for (const step of task.steps) {
      for (const id of step.elementIds) if (!owned.has(id)) owned.set(id, step.id)
      if (step.kind !== 'scaffold') continue
      const emitted = new Set(planScaffoldCoverage(plan, step).emitted)
      for (const id of emitted) if (!scaffolded.has(id)) scaffolded.set(id, step.id)
      const [model] = plan.models.filter((candidate) => emitted.has(candidate.id))
      const written = validators.filter((validator) => emitted.has(validator.id) && validator.module === undefined)
      if (model && model.module === undefined && written.length > 0) validatorFiles.set(validatorFilePath(model), written.map((validator) => validator.id))
    }
  }
  const routeFiles = new Map(planScaffoldMounts(plan, derivation).map((mount) => [mount.path, mount.routes]))

  const validatorById = new Map(validators.map((validator) => [validator.id, { id: validator.id, module: validator.module, label: `validator ${validator.name}` }]))

  return {
    match(target: PlanGeneratorTarget, module: string | undefined): Added[] {
      switch (target.section) {
        case 'models':
        case 'controllers':
        case 'resources':
        case 'policies':
          return classes[target.section].filter((element) => target.names.includes(element.name) && sameModule(element, module))
        case 'policyProviders':
          return classes.policies
            .filter((policy) => target.names.includes(`${policy.name}Provider`) && sameModule(policy, module))
            .map((policy) => ({ ...policy, label: `the provider ${policy.name}Provider of policy ${policy.name}` }))
        case 'sideEffects':
          return effects
            .filter((effect) => effect.kind === target.kind && target.names.includes(effect.name) && sameModule(effect, module))
            .map((effect) => ({ id: effect.id, module: effect.module, label: `${effect.kind} ${effect.name}` }))
        case 'validators': {
          const exports = Object.values(validatorSchemaNames(target.entity))
          const named = validators.filter((candidate) => exports.includes(candidate.name) && sameModule(candidate, module)).map((candidate) => candidate.id)
          const inFile = module === undefined ? (validatorFiles.get(validatorFile(target.entity).path) ?? []) : []
          return [...new Set([...named, ...inFile])].map((id) => validatorById.get(id)!)
        }
        case 'tables':
          return tables.filter((model) => target.names.includes(model.table))
        case 'routes': {
          const ids = module === undefined ? (routeFiles.get(target.file) ?? []) : []
          return ids.flatMap((id) => {
            const route = routes.get(id)
            return route ? [{ id, label: `route ${route.name}` }] : []
          })
        }
      }
    },
    writer(element: Added): PlanCommandTargetHit['step'] {
      const scaffold = element.module === undefined ? scaffolded.get(element.id) : undefined
      if (scaffold !== undefined) return { id: scaffold, scaffold: true }
      const owner = owned.get(element.id)
      return owner === undefined ? undefined : { id: owner, scaffold: false }
    },
  }
}
