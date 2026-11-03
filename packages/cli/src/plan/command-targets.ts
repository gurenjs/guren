/**
 * What each generator a plan's `commands` may run writes or imports, by plan section (RFC 0030 §2).
 * The commands run first, in Foundation, so a generator for an element the plan adds or renames is
 * judged by what that breaks: a target `plan:scaffold` then refuses, or output importing what no step
 * has written yet, which fails the commands step's typecheck. Names come from the generators' own
 * helpers. `tests/plan-command-targets.test.ts` holds the table to the allowlist, the registry's flags
 * and `make:auth`'s output.
 */

import { basename } from 'node:path'

import { ADMIN_DASHBOARD_CONTROLLER_PATH, BLUEPRINT_SAMPLES, OAUTH_CONTROLLER_PATH } from '../blueprint-samples'
import { schemaIdentifierFor, singularize, tableNameFor } from '../inflect'
import { authFeaturesFor } from '../make-auth'
import { eventFile } from '../make-event'
import { jobFile } from '../make-job'
import { listenerFile } from '../make-listener'
import { mailFile } from '../make-mail'
import { modelFile } from '../make-model'
import { notificationFile } from '../make-notification'
import { policyFile } from '../make-policy'
import { routeFile, routeGroupController } from '../make-route'
import { validatorFile, validatorSchemaNames } from '../make-validator'
import { ensureSuffix, kebabCase, pascalCase, type ScaffoldFileEntry } from '../utils'
import { findTable, isUnreadable, type PlanAppState } from './app-state'
import { namedTargets, tableTarget, type PlanAppTarget } from './app-targets'
import { judgePlanCommand, quotePlanCommand } from './command-allowlist'
import { planScaffoldCoverage, planScaffoldMounts } from './scaffold'
import { validatorFilePath } from './scaffold-http'
import type { PlanDraft, PlanSideEffect } from './schema'
import type { PlanTaskDerivation } from './tasks'

type ClassSection = 'models' | 'controllers' | 'resources' | 'policies'

/** What a generator's output imports that may be missing at the start: a `db/schema` export, or a page `pages.gen.ts` lists. */
export type PlanGeneratorNeed = { schema: string } | { page: string }

export type PlanGeneratorTarget =
  | { section: ClassSection; names: readonly string[]; needs?: PlanGeneratorNeed }
  | { section: 'sideEffects'; kind: PlanSideEffect['kind']; names: readonly string[] }
  /** A policy's provider, `<Policy>Provider`, which `plan:scaffold` writes beside the policy. */
  | { section: 'policyProviders'; names: readonly string[] }
  /** A validator file and the schemas it exports. */
  | { section: 'validators'; file: string; exports: readonly string[] }
  /** An app-relative routes file. */
  | { section: 'routes'; file: string }
  /** SQL table names, matched against a planned model's `table` in any root, and whether the generator also writes their migration. */
  | { section: 'tables'; names: readonly string[]; migration: boolean }

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
/** The class a generator's file declares, which every `make:*` names its file after. */
const declared = (entry: Pick<ScaffoldFileEntry, 'path'>): string => basename(entry.path, '.ts')
const flagOn = (call: PlanGeneratorCall, flag: string): boolean => call.flags.get(flag) === true || call.flags.get(flag) === 'true'
const stringFlag = (call: PlanGeneratorCall, ...names: string[]): string | undefined =>
  names.map((name) => call.flags.get(name)).find((value): value is string => typeof value === 'string')
const sideEffect = (kind: PlanSideEffect['kind'], ...names: string[]): PlanGeneratorTarget => ({ section: 'sideEffects', kind, names })

/** The validator file `make:validator` writes for an entity, with its three schemas. */
function entityValidators(entity: string): PlanGeneratorTarget {
  return { section: 'validators', file: validatorFile(entity).path, exports: Object.values(validatorSchemaNames(entity)) }
}

/** The schemas each validator file `make:auth` writes exports, by the entity the file is named after; the test pins them against its output. */
const AUTH_VALIDATOR_EXPORTS: Readonly<Record<string, readonly string[]>> = {
  Profile: ['ProfileUpdateSchema'],
  Login: ['LoginSchema'],
  Register: ['RegisterSchema'],
  ForgotPassword: ['ForgotPasswordSchema'],
  ResetPassword: ['ResetPasswordSchema'],
}

/** A model class as `make:model` writes it, importing its table's `db/schema` export. */
function modelTarget(name: string): PlanGeneratorTarget {
  const model = declared(modelFile(name))
  return { section: 'models', names: [model], needs: { schema: schemaIdentifierFor(model) } }
}

function sideEffectRule(kind: PlanSideEffect['kind'], file: (name: string) => ScaffoldFileEntry): PlanGeneratorRule {
  return { valueFlags: MODULE, positional: true, targets: ({ name }) => writes(sideEffect(kind, declared(file(name!)))) }
}

/** `make:feature` and `add resource`, which write the pages their controller renders; `make:feature --policy` adds the policy. */
function featureTargets(singular: string, policy: boolean): PlanGeneratorTargets {
  return writes(
    modelTarget(singular),
    { section: 'controllers', names: [`${singular}Controller`] },
    { section: 'resources', names: [`${singular}Resource`] },
    entityValidators(singular),
    ...(policy ? [{ section: 'policies' as const, names: [declared(policyFile(singular))] }] : []),
  )
}

/** The classes, validator files and tables `make:auth` writes for its flags; the test pins them against its output. */
function authTargets(call: PlanGeneratorCall): PlanGeneratorTargets {
  const features = authFeaturesFor({ minimal: flagOn(call, 'minimal'), verify: flagOn(call, 'verify'), oauth: stringFlag(call, 'oauth'), oauthOnly: flagOn(call, 'oauth-only') })
  const oauth = features.oauthProviders.length > 0
  const controllers = ['LoginController', 'DashboardController', 'ProfileController']
  const mails: string[] = []
  const validators = ['Profile', ...(features.includePassword ? ['Login'] : [])]
  if (features.includeExtras) {
    controllers.push('RegisterController', 'ForgotPasswordController', 'ResetPasswordController')
    mails.push('PasswordResetMail')
    validators.push('Register', 'ForgotPassword', 'ResetPassword')
  }
  if (features.includeVerify) {
    controllers.push('VerifyEmailController')
    mails.push('EmailVerificationMail')
  }
  if (oauth) controllers.push(declared({ path: OAUTH_CONTROLLER_PATH }))
  // The users table is written beside the model, so `User` imports nothing missing.
  const tables = ['users', ...(flagOn(call, 'no-session') ? [] : ['sessions']), ...(oauth ? ['oauth_states'] : [])]
  return writes(
    { section: 'models', names: ['User'] },
    { section: 'controllers', names: controllers },
    sideEffect('mail', ...mails),
    ...validators.map((entity): PlanGeneratorTarget => ({ section: 'validators', file: validatorFile(entity).path, exports: AUTH_VALIDATOR_EXPORTS[entity] ?? [] })),
    { section: 'tables', names: tables, migration: true },
  )
}

const BLUEPRINT = { valueFlags: [], positional: false } as const

/** Total over `planGeneratorNames()`: a string is why the generator is not judged. */
export const PLAN_GENERATOR_TARGETS: Readonly<Record<string, PlanGeneratorRule | string>> = Object.assign(Object.create(null), {
  'make:controller': {
    valueFlags: MODULE,
    positional: true,
    targets: ({ name, flags }) => {
      const controller = suffixed(name!, 'Controller')
      const module = stringFlag({ flags }, 'module', 'M')
      // The Inertia template renders `<resource>/Index` (`make-controller.ts`); in an API-only app it writes JSON.
      const page = `${module === undefined ? '' : `${kebabCase(module)}/`}${kebabCase(controller.replace(/Controller$/u, ''))}/Index`
      return writes({ section: 'controllers', names: [controller], needs: { page } })
    },
  },
  'make:model': { valueFlags: MODULE, positional: true, targets: ({ name }) => writes(modelTarget(name!)) },
  'make:view': 'a page, which no scaffold writes; its template imports only Inertia and React, so the pages step edits it in place',
  'make:route': {
    valueFlags: MODULE,
    positional: true,
    targets: ({ name }) => ({
      writes: [{ section: 'routes', file: routeFile(name!).path }],
      imports: [{ section: 'controllers', names: [routeGroupController(className(name!))] }],
    }),
  },
  'make:job': sideEffectRule('job', jobFile),
  'make:event': sideEffectRule('event', eventFile),
  'make:mail': sideEffectRule('mail', mailFile),
  'make:middleware': 'a middleware, which no plan section declares',
  'make:policy': { valueFlags: MODULE, positional: true, targets: ({ name }) => writes({ section: 'policies', names: [declared(policyFile(name!))] }) },
  'make:seeder': 'a seeder, which no plan section declares',
  'make:notification': sideEffectRule('notification', notificationFile),
  'make:provider': { valueFlags: MODULE, positional: true, targets: ({ name }) => writes({ section: 'policyProviders', names: [suffixed(name!, 'Provider')] }) },
  'make:adr': 'a decision record, which no plan section declares',
  'make:validator': { valueFlags: ['fields', 'F', ...MODULE], positional: true, targets: ({ name }) => writes(entityValidators(unsuffixed(name!, 'Validator'))) },
  'make:agent': 'a durable agent, which no plan section declares',
  'make:ai-agent': 'an in-process agent, which no plan section declares',
  'make:module': 'a module skeleton, which elements in that module need before any step writes them',
  'make:channel': 'a broadcast channel, which no plan section declares',
  'make:command': 'a console command, which no plan section declares',
  'make:exception': 'an exception class, which no plan section declares',
  'make:factory': {
    valueFlags: ['model', 'm', ...MODULE],
    positional: true,
    targets: (call) => ({ writes: [], imports: [{ section: 'models', names: [stringFlag(call, 'model', 'm') ?? unsuffixed(call.name!, 'Factory')] }] }),
  },
  'make:listener': {
    valueFlags: ['event', 'e', ...MODULE],
    positional: true,
    targets: (call) => {
      const event = stringFlag(call, 'event', 'e')
      return {
        writes: [sideEffect('listener', declared(listenerFile(call.name!)))],
        imports: event === undefined ? [] : [sideEffect('event', declared(eventFile(event)))],
      }
    },
  },
  'make:resource': {
    valueFlags: ['model', 'm', ...MODULE],
    positional: true,
    targets: (call) => ({
      writes: [{ section: 'resources', names: [suffixed(call.name!, 'Resource')] }],
      imports: [{ section: 'models', names: [stringFlag(call, 'model', 'm') ?? unsuffixed(call.name!, 'Resource')] }],
    }),
  },
  'make:test': 'a test file, which imports no element',
  'make:lang': 'a translation catalog, which no plan section declares',
  'make:feature': {
    valueFlags: ['fields', 'F', 'attach', ...MODULE],
    positional: true,
    targets: (call) => {
      const singular = className(call.name!)
      return flagOn(call, 'prototype') ? writes(entityValidators(singular)) : featureTargets(singular, flagOn(call, 'policy'))
    },
  },
  'lang:publish': "the framework's translation catalogs, which no plan section declares",
  'add admin': { ...BLUEPRINT, targets: () => writes({ section: 'controllers', names: [declared({ path: ADMIN_DASHBOARD_CONTROLLER_PATH })] }) },
  // It prints a `db:make` hint rather than generating the migration.
  'add attachments': { ...BLUEPRINT, targets: () => writes({ section: 'tables', names: ['attachments'], migration: false }) },
  'add broadcasting': 'broadcast channels and their provider, which no plan section declares',
  'add cache': 'the cache config and a cache service, which no plan section declares',
  'add events': {
    ...BLUEPRINT,
    targets: () => writes(sideEffect('event', declared(eventFile(BLUEPRINT_SAMPLES.event))), sideEffect('listener', declared(listenerFile(BLUEPRINT_SAMPLES.listener)))),
  },
  'add lint': 'the lint config and scripts, which no plan section declares',
  'add mail': { ...BLUEPRINT, targets: () => writes(sideEffect('mail', declared(mailFile(BLUEPRINT_SAMPLES.mail)))) },
  'add notifications': { ...BLUEPRINT, targets: () => writes(sideEffect('notification', declared(notificationFile(BLUEPRINT_SAMPLES.notification)))) },
  'add queue': { ...BLUEPRINT, targets: () => writes(sideEffect('job', declared(jobFile(BLUEPRINT_SAMPLES.job)))) },
  'add resource': {
    valueFlags: ['fields', 'F', 'attach'],
    positional: true,
    targets: ({ name }) => {
      const singular = singularize(className(name!))
      const [, ...rest] = featureTargets(singular, false).writes
      // It appends the model's table itself, so the model imports nothing missing; it generates no migration.
      return writes({ section: 'models', names: [declared(modelFile(singular))] }, ...rest, { section: 'tables', names: [tableNameFor(singular)], migration: false })
    },
  },
  'add prototype': 'the prototype fixture and its wiring, which no plan section declares',
  'add schedule': 'the schedule kernel and its provider, which no plan section declares',
  'add storage': 'the storage config and a storage service, which no plan section declares',
  'add ui': 'UI components, which no plan section declares',
  'make:auth': { valueFlags: ['oauth'], positional: false, targets: authTargets },
  'add auth': { ...BLUEPRINT, targets: authTargets },
  'add oauth': {
    ...BLUEPRINT,
    targets: () => writes({ section: 'controllers', names: [declared({ path: OAUTH_CONTROLLER_PATH })] }, { section: 'tables', names: ['oauth_states'], migration: true }),
  },
  'add session': { ...BLUEPRINT, targets: () => writes({ section: 'tables', names: ['sessions'], migration: true }) },
  'add ai': {
    valueFlags: ['provider'],
    positional: false,
    targets: (call) => (flagOn(call, 'no-conversations') ? writes() : writes({ section: 'tables', names: ['ai_conversations', 'ai_messages'], migration: true })),
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

/**
 * Why a command breaks the plan: `scaffold`, the step is `plan:scaffold`'s and refuses the target the
 * command left; `table`, a second declaration of a table the step declares (with a migration when the
 * generator writes one); the others fail the commands step's typecheck on what the output imports.
 */
export type PlanCommandTargetProblem =
  | { kind: 'scaffold' }
  | { kind: 'table'; migration: boolean }
  | { kind: 'imports' }
  | { kind: 'schema'; identifier: string }
  | { kind: 'page'; page: string }

export interface PlanCommandTargetHit {
  elementId: string
  /** What the element is and its name, as a message names it: `model Comment`. */
  label: string
  /** The step that writes the element, and whether `plan:scaffold` writes it there. */
  step: { id: string; scaffold: boolean } | undefined
  problem: PlanCommandTargetProblem
}

export interface PlanCommandTargets {
  id: string
  quoted: string
  hits: PlanCommandTargetHit[]
}

interface Planned {
  id: string
  module?: string
  name: string
  label: string
}

const sameModule = (element: { module?: string }, module: string | undefined): boolean =>
  (element.module === undefined ? undefined : kebabCase(element.module)) === module

/** Only an added or renamed name is absent when the plan starts; `app-targets.ts` says which name each element is judged by. */
const startsAbsent = (target: PlanAppTarget): boolean => target.kind === 'add' || target.kind === 'rename'

const NOUNS: Record<string, string> = { models: 'model', controllers: 'controller', validators: 'validator', resources: 'resource', policies: 'policy' }

/**
 * Every allowed command whose generator breaks the plan, in command order. A write is a finding only
 * where `plan:scaffold` writes the element, it is a table, or the output needs something missing; a
 * hand-written step edits any other stub. A word the reader cannot place, or an unread section, adds nothing.
 */
export function planCommandTargets(
  plan: PlanDraft,
  app: Pick<PlanAppState, 'tables' | 'pages' | 'apiOnly'>,
  derivation: () => PlanTaskDerivation,
): PlanCommandTargets[] {
  const read = plan.commands.flatMap((command) => {
    const verdict = judgePlanCommand(command.command)
    const rule = verdict.allowed ? PLAN_GENERATOR_TARGETS[verdict.subcommand] : undefined
    if (!verdict.allowed || rule === undefined || typeof rule === 'string') return []
    const call = readPlanGeneratorCall(rule, verdict.args)
    if (call === undefined) return []
    const module = stringFlag(call, 'module', 'M')
    return [{ command, targets: rule.targets(call), module: module === undefined ? undefined : kebabCase(module) }]
  })
  if (read.length === 0) return []

  const index = indexPlanned(plan, derivation())
  const missing = (need: PlanGeneratorNeed | undefined, module: string | undefined): PlanCommandTargetProblem | undefined => {
    if (need === undefined) return undefined
    if ('schema' in need) {
      if (isUnreadable(app.tables) || findTable(app.tables, need.schema, module ?? null)) return undefined
      return { kind: 'schema', identifier: need.schema }
    }
    if (app.apiOnly || isUnreadable(app.pages) || app.pages.some((page) => page.name === need.page)) return undefined
    return { kind: 'page', page: need.page }
  }

  return read.flatMap(({ command, targets, module }) => {
    const hits = new Map<string, PlanCommandTargetHit>()
    const hit = (element: Planned, problem: PlanCommandTargetProblem | undefined): void => {
      if (problem !== undefined && !hits.has(element.id)) hits.set(element.id, { elementId: element.id, label: element.label, step: index.writer(element), problem })
    }
    for (const target of targets.writes) {
      for (const element of index.match(target, module)) {
        if (index.writer(element)?.scaffold) hit(element, { kind: 'scaffold' })
        // The step declares this table, so one already in db/schema.ts is a second declaration rather than
        // a stub to edit, and a generated migration is applied and forward-only.
        else if (target.section === 'tables') hit(element, { kind: 'table', migration: target.migration })
        else if ('needs' in target) hit(element, missing(target.needs, module))
      }
    }
    for (const target of targets.imports) {
      for (const element of index.match(target, module)) hit(element, { kind: 'imports' })
    }
    return hits.size > 0 ? [{ id: command.id, quoted: quotePlanCommand(command.command), hits: [...hits.values()] }] : []
  })
}

function indexPlanned(plan: PlanDraft, derivation: PlanTaskDerivation) {
  const named = namedTargets(plan).filter(startsAbsent)
  const inSection = (section: string): Planned[] =>
    named.filter((target) => target.section === section).map((target) => ({ id: target.id, module: target.module, name: target.current, label: `${NOUNS[section]} ${target.current}` }))
  const classes: Record<ClassSection, Planned[]> = {
    models: inSection('models'),
    controllers: inSection('controllers'),
    resources: inSection('resources'),
    policies: inSection('policies'),
  }
  const validators = inSection('validators')
  const tables = plan.models.flatMap((model) => {
    const target = tableTarget(model)
    return startsAbsent(target) ? [{ id: model.id, module: model.module, name: target.current, label: `table ${target.current} of model ${model.name}` }] : []
  })
  const effects = plan.sideEffects
    .filter((effect) => effect.change.kind === 'add' || effect.change.kind === 'rename')
    .map((effect) => ({ id: effect.id, module: effect.module, kind: effect.kind, name: effect.name, label: `${effect.kind} ${effect.name}` }))
  const routes = new Map(plan.routes.map((route) => [route.id, route]))

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
  const validatorById = new Map(validators.map((validator) => [validator.id, validator]))

  return {
    match(target: PlanGeneratorTarget, module: string | undefined): Planned[] {
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
          return effects.filter((effect) => effect.kind === target.kind && target.names.includes(effect.name) && sameModule(effect, module))
        case 'validators': {
          const named = validators.filter((candidate) => target.exports.includes(candidate.name) && sameModule(candidate, module)).map((candidate) => candidate.id)
          const inFile = module === undefined ? (validatorFiles.get(target.file) ?? []) : []
          return [...new Set([...named, ...inFile])].map((id) => validatorById.get(id)!)
        }
        case 'tables':
          return tables.filter((model) => target.names.includes(model.name))
        case 'routes': {
          const ids = module === undefined ? (routeFiles.get(target.file) ?? []) : []
          return ids.flatMap((id) => {
            const route = routes.get(id)
            return route ? [{ id, name: route.name, label: `route ${route.name}` }] : []
          })
        }
      }
    },
    writer(element: Planned): PlanCommandTargetHit['step'] {
      const scaffold = element.module === undefined ? scaffolded.get(element.id) : undefined
      if (scaffold !== undefined) return { id: scaffold, scaffold: true }
      const owner = owned.get(element.id)
      return owner === undefined ? undefined : { id: owner, scaffold: false }
    },
  }
}
