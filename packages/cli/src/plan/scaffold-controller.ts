/**
 * The controller, routes and side-effect half of the plan scaffold (RFC 0030 §5, Part 3 item 6),
 * pure like `scaffold.ts`, which calls it. A controller holds exactly the planned actions, each
 * validating and authorizing as planned and then answering 501; nothing a reader credits as a
 * response is written. The routes go in an unmounted `routes/<collection>.ts` (D5), which the
 * `http` step mounts with `plan:scaffold --mount` (D3). Side-effect classes are `make:*`'s own.
 */

import { CONTROLLER_MEMBER_KINDS } from '../controller-methods'
import { CONTROLLERS_DIR, ROUTES_DIR, SIDE_EFFECT_DIRS } from '../discovery'
import { collectionSlug } from '../inflect'
import { buildControllerSource, type ControllerActionSource } from '../make-controller'
import { buildEventSource } from '../make-event'
import { buildJobSource } from '../make-job'
import { buildListenerSource } from '../make-listener'
import { buildMailSource } from '../make-mail'
import { buildNotificationSource } from '../make-notification'
import { AUTH_ALIAS, authAliasLine, buildRoutesSource, routeCall } from '../make-route'
import { quoteString } from '../schema-columns'
import { camelCase, isBindingName, isIdentifier, pascalCase, quoteObjectKey, relativeImportPath } from '../utils'
import { entityDocPath } from './close-docs'
import type { PlanScaffoldUnwritten } from './scaffold-http'
import type { PlanAction, PlanController, PlanDraft, PlanModel, PlanRoute, PlanSideEffect } from './schema'

const CONTRACT_FIELDS = ['params', 'query', 'body'] as const

/** Abilities asked of one record, which the gate resolves only from `[Model, record]`: an ORM record carries no class. */
const RECORD_ABILITIES: ReadonlySet<string> = new Set(['view', 'show', 'update', 'edit', 'delete', 'destroy', 'restore', 'forceDelete'])

/** `Controller`'s own members, which an action of the same name would replace. */
const CONTROLLER_MEMBERS: ReadonlySet<string> = new Set(['constructor', ...Object.keys(CONTROLLER_MEMBER_KINDS)])

/** The routes file a scaffold step writes for its entity, and the registrar it exports: `plan:scaffold`, `--mount`, `plan:next` and `guren check` all read it here. */
export function scaffoldRoutesFile(model: Pick<PlanModel, 'name'>): { path: string; registrar: string } {
  return { path: `${ROUTES_DIR}/${collectionSlug(model.name)}.ts`, registrar: `register${model.name}Routes` }
}

export function controllerFilePath(controller: PlanController): string {
  return `${CONTROLLERS_DIR}/${controller.className}.ts`
}

const SIDE_EFFECT_SOURCES: Record<PlanSideEffect['kind'], (className: string) => string> = {
  job: buildJobSource,
  event: buildEventSource,
  // The plan's `trigger` is prose, so the listener names no event: make:listener's shape without --event.
  listener: buildListenerSource,
  mail: buildMailSource,
  notification: buildNotificationSource,
}

/** A class the scaffold names a file after, which discovery reads back by that file name. */
function classNameRefusal(id: string, name: string, kind: string): string[] {
  return isBindingName(name) && pascalCase(name) === name ? [] : [`${id} is named "${name}", which is not a PascalCase class name a ${kind} file can be named after.`]
}

/** `plan:status` finds a side-effect class by its file name in the kind's directory. */
export function sideEffectFilePath(effect: PlanSideEffect): string {
  return `${SIDE_EFFECT_DIRS[effect.kind]}/${effect.name}.ts`
}

export function buildPlanSideEffectSource(effect: PlanSideEffect): string {
  return SIDE_EFFECT_SOURCES[effect.kind](effect.name)
}

export function sideEffectRefusals(effect: PlanSideEffect, declared: readonly string[]): string[] {
  const refusals = classNameRefusal(effect.id, effect.name, effect.kind)
  if (declared.includes(effect.name)) refusals.push(`${effect.id}: the application already declares a ${effect.kind} ${effect.name}.`)
  return refusals
}

export function controllerRefusals(controller: PlanController, actions: readonly PlanAction[], declared: readonly string[]): string[] {
  const refusals = classNameRefusal(controller.id, controller.className, 'controller')
  if (declared.includes(controller.className)) refusals.push(`${controller.id}: the application already declares a ${controller.className} controller.`)
  const seen = new Set<string>()
  for (const action of actions) {
    if (!isIdentifier(action.name)) refusals.push(`${action.id} is named "${action.name}", which a method cannot be named, and a route dispatches to a method by name.`)
    else if (CONTROLLER_MEMBERS.has(action.name)) refusals.push(`${action.id} is named "${action.name}", which would replace Controller's own ${action.name}(). Rename the action (plan:revise).`)
    if (seen.has(action.name)) refusals.push(`${controller.id} plans the action "${action.name}" twice.`)
    seen.add(action.name)
  }
  return refusals
}

/** A class or schema the emitted files import: its export name and the app-relative file declaring it. */
interface ImportedSymbol {
  name: string
  file: string
}

export interface PlanScaffoldSymbols {
  /** Each model class the root declares after this run, by name, with its file. */
  models: ReadonlyMap<string, string>
  /** Each validator schema the root's validator files export after this run, by name, with its file. */
  validators: ReadonlyMap<string, string>
  /** App-relative files that exist, which a `@docs` tag may name. */
  docs: ReadonlySet<string>
}

/** `import { ... } from '...'` lines, one per file, in the order files were first named. */
class Imports {
  private readonly byFile = new Map<string, Set<string>>()

  constructor(private readonly from: string) {}

  add(symbol: ImportedSymbol): string {
    const names = this.byFile.get(symbol.file) ?? new Set<string>()
    names.add(symbol.name)
    this.byFile.set(symbol.file, names)
    return symbol.name
  }

  lines(): string[] {
    return [...this.byFile].map(([file, names]) => `import { ${[...names].sort().join(', ')} } from '${importSpecifier(this.from, file)}'`)
  }
}

/** The specifier an app file imports another by, with the runtime extension the scaffolds write. */
export function importSpecifier(from: string, to: string): string {
  return relativeImportPath(from, to).replace(/\.tsx?$/u, '.js')
}

function oneLine(text: string): string {
  return text.replace(/\s+/gu, ' ').trim()
}

/** The model's foreign keys a payload cannot fill, which `create()` refuses unless they come through `set`. */
function unfillableForeignKeys(model: PlanModel): string[] {
  return model.columns
    .filter((column) => column.references && !column.primaryKey && column.change.kind !== 'drop' && !model.fillable.includes(column.name))
    .map((column) => column.name)
}

function describeResponse(plan: PlanDraft, response: PlanAction['response']): string {
  const named = (id: string): string => {
    const element = [...plan.views.map((view) => ({ id: view.id, name: view.page })), ...plan.resources].find((candidate) => candidate.id === id)
    return element?.name ?? id
  }
  switch (response.kind) {
    case 'inertia':
      return `the Inertia page ${named(response.view)}`
    case 'redirect':
      return `a redirect to ${oneLine(response.to)}`
    case 'resource':
      return `the resource ${named(response.resource)}`
    case 'json':
      return `JSON: ${oneLine(response.description)}`
    case 'empty':
      return 'no content'
  }
}

export class PlanHttpEmitter {
  constructor(
    private readonly plan: PlanDraft,
    private readonly symbols: PlanScaffoldSymbols,
    private readonly unwritten: PlanScaffoldUnwritten[],
  ) {}

  private leave(element: string, detail: string, reason: string): void {
    this.unwritten.push({ element, detail, reason })
  }

  private validator(id: string): ImportedSymbol | string {
    const planned = this.plan.validators.find((validator) => validator.id === id)
    if (!planned) return `the plan declares no ${id}`
    const file = this.symbols.validators.get(planned.name)
    return file === undefined ? `no root validator file exports ${planned.name} after this step, so the file cannot import it` : { name: planned.name, file }
  }

  private model(id: string): ImportedSymbol | string {
    const planned = this.plan.models.find((model) => model.id === id)
    if (!planned) return `the plan declares no ${id}`
    const file = this.symbols.models.get(planned.name)
    return file === undefined ? `the root declares no ${planned.name} model after this step, so the file cannot import it` : { name: planned.name, file }
  }

  private docsComment(model: PlanModel): string[] {
    const doc = entityDocPath(model)
    return this.symbols.docs.has(doc) ? ['', `@docs ${doc}`] : []
  }

  /** A validator the plan names but the file cannot import is listed as unwritten, never emitted. */
  private validation(action: PlanAction, field: (typeof CONTRACT_FIELDS)[number], imports: Imports): string[] {
    const id = action[field]
    if (!id) return []
    const schema = this.validator(id)
    if (typeof schema === 'string') {
      this.leave(action.id, `${field} validator`, schema)
      return []
    }
    const name = imports.add(schema)
    return [field === 'body' ? `    await this.validateBody(${name})` : `    this.validate${field === 'query' ? 'Query' : 'Params'}(${name})`]
  }

  /**
   * The planned validators and policy ability run for real, before the 501: a request the plan
   * rejects is rejected already. The ability is asked before the body is read, so a caller the
   * policy denies gets 403 whatever it sent. No response is written: the readers credit the one named.
   */
  private action(controller: PlanController, action: PlanAction, model: PlanModel, imports: Imports): ControllerActionSource {
    const lines = [...this.validation(action, 'params', imports), ...this.validation(action, 'query', imports)]
    const notes: string[] = []
    const routes = this.plan.routes.filter((route) => route.action === action.id)
    const policy = action.authorization.policy
    if (policy) {
      const planned = this.plan.policies.find((candidate) => candidate.id === policy.id)
      const subject = planned ? this.model(planned.model) : `the plan declares no ${policy.id}`
      if (typeof subject === 'string') this.leave(action.id, 'policy ability', subject)
      else {
        const name = imports.add(subject)
        const ability = quoteString(policy.ability)
        const record = isBindingName(camelCase(name)) ? camelCase(name) : 'record'
        // this.model() throws on a route that binds no record of the class, so every route must bind exactly one.
        if (routes.length > 0 && routes.every((route) => route.bind.filter((binding) => binding.model === planned!.model).length === 1)) {
          lines.push(`    const ${record} = this.model(${name})`, `    await this.authorize(${ability}, [${name}, ${record}])`)
        } else {
          lines.push(`    await this.authorize(${ability}, ${name})`)
          if (RECORD_ABILITIES.has(policy.ability)) {
            notes.push(`${policy.ability} is asked of one ${name}: once the action loads it, pass [${name}, ${record}], since the bare class reaches the policy with no record`)
          }
        }
      }
    }
    lines.push(...this.validation(action, 'body', imports))
    const serverSet = action.body && routes.some((route) => route.method === 'POST') ? unfillableForeignKeys(model) : []
    if (serverSet.length > 0) {
      const keys = serverSet.join(', ')
      notes.push(`${keys} ${serverSet.length === 1 ? 'is' : 'are'} not fillable: write ${serverSet.length === 1 ? 'it' : 'them'} with ${model.name}.create(data, { set: { ${keys} } }) (RFC 0031)`)
    }
    const response = describeResponse(this.plan, action.response)
    this.leave(action.id, 'response', `the stub answers 501 until the http step writes ${response}`)
    lines.push(`    throw HttpException.notImplemented(${quoteString(`${controller.className}.${action.name} is planned and not written yet`)})`)
    return {
      name: action.name,
      comment: [`Planned response: ${response}`, ...action.rules.map((rule) => `Rule: ${oneLine(rule)}`), ...notes],
      body: lines.join('\n'),
    }
  }

  controller(controller: PlanController, actions: readonly PlanAction[], model: PlanModel): string {
    const path = controllerFilePath(controller)
    const imports = new Imports(path)
    const sources = actions.map((action) => this.action(controller, action, model, imports))
    return buildControllerSource({
      className: controller.className,
      coreImports: sources.length > 0 ? ['HttpException'] : [],
      imports: imports.lines(),
      classComment: ['Written by plan:scaffold: each action validates and authorizes as planned, then answers 501 until the http step writes it.', ...this.docsComment(model)],
      actions: sources,
    })
  }

  /**
   * The registrar a scaffold step writes, which nothing calls until `--mount` inserts its call at
   * the start of the entry registrar. There its `auth` alias is set first, so an alias the entry
   * sets for the same name replaces it at mount rather than being replaced.
   */
  routes(model: PlanModel, routes: readonly PlanRoute[]): string {
    const { path, registrar } = scaffoldRoutesFile(model)
    const imports = new Imports(path)
    const controllers = new Map<string, string>()
    const actionOwner = new Map(this.plan.controllers.flatMap((controller) => controller.actions.map((action) => [action.id, { controller, action }] as const)))
    let authed = false
    const lines = routes.map((route) => {
      const { controller, action } = actionOwner.get(route.action)!
      controllers.set(controller.className, controllerFilePath(controller))
      const contract = [`name: ${quoteString(route.name)}`]
      for (const field of CONTRACT_FIELDS) {
        const id = action[field]
        if (!id) continue
        const schema = this.validator(id)
        if (typeof schema === 'string') this.leave(route.id, `${field} contract`, schema)
        else contract.push(`${field}: ${imports.add(schema)}`)
      }
      const bindings = route.bind.flatMap((binding) => {
        const bound = this.model(binding.model)
        if (typeof bound === 'string') {
          this.leave(route.id, `bind ${binding.param}`, bound)
          return []
        }
        const name = imports.add(bound)
        return [`${quoteObjectKey(binding.param)}: ${binding.key ? `[${name}, ${quoteString(binding.key)}]` : name}`]
      })
      if (bindings.length > 0) contract.push(`bind: { ${bindings.join(', ')} }`)
      if (route.agent) contract.push(`agent: { toolName: ${quoteString(route.agent.toolName)}, readOnlyHint: ${route.agent.readOnly} }`)
      // The action's own authorization middleware runs on the route too: that is where a middleware applies.
      const middleware = [...new Set([...route.middleware, ...action.authorization.middleware])].filter((name) => {
        if (name === AUTH_ALIAS) return true
        this.leave(route.id, `middleware ${name}`, `plan:scaffold registers only the ${AUTH_ALIAS} alias; the http step applies ${name} with the handler the application aliases it to`)
        return false
      })
      const chain = middleware.map((name) => `.middleware(${quoteString(name)})`).join('')
      authed ||= middleware.length > 0
      const receiver = middleware.length > 0 ? 'authRouter' : 'router'
      return routeCall(receiver, route.method.toLowerCase(), route.path, `[${controller.className}, ${quoteString(action.name)}]`, { contract: `{ ${contract.join(', ')} }`, chain })
    })
    const controllerImports = [...controllers].map(([className, file]) => `import ${className} from '${importSpecifier(path, file)}'`)
    return buildRoutesSource({
      coreImports: authed ? ['requireAuthenticated'] : [],
      imports: [...controllerImports, ...imports.lines()],
      registrar,
      comment: [
        'Written by plan:scaffold and not mounted: the http step mounts it with `plan:scaffold --mount`,',
        'which calls it first in the entry registrar, so an auth alias the entry sets replaces the one here.',
        ...this.docsComment(model),
      ],
      body: [...(authed ? [authAliasLine('authRouter', 'router')] : []), ...lines],
    })
  }
}
