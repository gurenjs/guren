/**
 * The controller, routes and side-effect half of the plan scaffold (RFC 0030 §5, Part 3 item 6),
 * pure like `scaffold.ts`, which calls it. A controller holds exactly the planned actions, each
 * validating and authorizing as planned and then answering 501; nothing a reader credits as a
 * response is written. The routes go in an unmounted `routes/<collection>.ts` (D5), which the
 * `http` step mounts with `plan:scaffold --mount` (D3). Side-effect classes are `make:*`'s own.
 */

import { posix } from 'node:path'

import { CONTROLLER_MEMBER_KINDS } from '../controller-methods'
import { CONTROLLERS_DIR, EVENTS_DIR, JOBS_DIR, LISTENERS_DIR, MAIL_DIR, NOTIFICATIONS_DIR, ROUTES_DIR } from '../discovery'
import { collectionSlug } from '../inflect'
import { buildControllerSource, type ControllerActionSource } from '../make-controller'
import { buildEventSource } from '../make-event'
import { buildJobSource } from '../make-job'
import { buildListenerSource } from '../make-listener'
import { buildMailSource } from '../make-mail'
import { buildNotificationSource } from '../make-notification'
import { authAliasLine, buildRoutesSource, routeCall } from '../make-route'
import { quoteString } from '../schema-columns'
import { isBindingName, isIdentifier, pascalCase, quoteObjectKey } from '../utils'
import { entityDocPath } from './close-docs'
import type { PlanScaffoldUnwritten } from './scaffold-http'
import type { PlanAction, PlanController, PlanDraft, PlanModel, PlanRoute, PlanSideEffect } from './schema'

/** The one middleware alias a scaffold knows the handler of (`authAliasLine()`); any other name is the http step's. */
const AUTH_ALIAS = 'auth'

const CONTRACT_FIELDS = ['params', 'query', 'body'] as const

/** `Controller`'s own members, which an action of the same name would replace. */
const CONTROLLER_MEMBERS: ReadonlySet<string> = new Set(['constructor', ...Object.keys(CONTROLLER_MEMBER_KINDS)])

/** The routes file a scaffold step writes for its entity, and the registrar it exports: `plan:scaffold`, `--mount`, `plan:next` and `guren check` all read it here. */
export function scaffoldRoutesFile(model: Pick<PlanModel, 'name'>): { path: string; registrar: string } {
  return { path: `${ROUTES_DIR}/${collectionSlug(model.name)}.ts`, registrar: `register${model.name}Routes` }
}

export function controllerFilePath(controller: PlanController): string {
  return `${CONTROLLERS_DIR}/${controller.className}.ts`
}

const SIDE_EFFECT_DIRS: Record<PlanSideEffect['kind'], string> = {
  job: JOBS_DIR,
  event: EVENTS_DIR,
  listener: LISTENERS_DIR,
  mail: MAIL_DIR,
  notification: NOTIFICATIONS_DIR,
}

const SIDE_EFFECT_SOURCES: Record<PlanSideEffect['kind'], (className: string) => string> = {
  job: buildJobSource,
  event: buildEventSource,
  // The plan's `trigger` is prose, so the listener names no event: make:listener's shape without --event.
  listener: (className) => buildListenerSource(className),
  mail: buildMailSource,
  notification: buildNotificationSource,
}

/** `plan:status` finds a side-effect class by its file name in the kind's directory. */
export function sideEffectFilePath(effect: PlanSideEffect): string {
  return `${SIDE_EFFECT_DIRS[effect.kind]}/${effect.name}.ts`
}

export function buildPlanSideEffectSource(effect: PlanSideEffect): string {
  return SIDE_EFFECT_SOURCES[effect.kind](effect.name)
}

export function sideEffectRefusals(effect: PlanSideEffect, declared: readonly string[]): string[] {
  const refusals: string[] = []
  if (!isBindingName(effect.name) || pascalCase(effect.name) !== effect.name) {
    refusals.push(`${effect.id} is named "${effect.name}", which is not a PascalCase class name a ${effect.kind} file can be named after.`)
  }
  if (declared.includes(effect.name)) refusals.push(`${effect.id}: the application already declares a ${effect.kind} ${effect.name}.`)
  return refusals
}

export function controllerRefusals(controller: PlanController, actions: readonly PlanAction[], declared: readonly string[]): string[] {
  const refusals: string[] = []
  if (!isBindingName(controller.className) || pascalCase(controller.className) !== controller.className) {
    refusals.push(`${controller.id} is named "${controller.className}", which is not a PascalCase class name a controller file can be named after.`)
  }
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
  const relative = posix.relative(posix.dirname(from), to).replace(/\.tsx?$/u, '.js')
  return relative.startsWith('.') ? relative : `./${relative}`
}

function oneLine(text: string): string {
  return text.replace(/\s+/gu, ' ').trim()
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

  /**
   * The planned validators and policy ability run for real, before the 501: a request the plan
   * rejects is rejected already. No response is written, since the readers credit the one named.
   */
  private action(controller: PlanController, action: PlanAction, imports: Imports): ControllerActionSource {
    const lines: string[] = []
    for (const field of CONTRACT_FIELDS) {
      const id = action[field]
      if (!id) continue
      const schema = this.validator(id)
      if (typeof schema === 'string') {
        this.leave(action.id, `${field} validator`, schema)
        continue
      }
      const name = imports.add(schema)
      lines.push(field === 'body' ? `    await this.validateBody(${name})` : `    this.validate${field === 'query' ? 'Query' : 'Params'}(${name})`)
    }
    const policy = action.authorization.policy
    if (policy) {
      const planned = this.plan.policies.find((candidate) => candidate.id === policy.id)
      const model = planned ? this.model(planned.model) : `the plan declares no ${policy.id}`
      if (typeof model === 'string') this.leave(action.id, 'policy ability', model)
      else lines.push(`    await this.authorize(${quoteString(policy.ability)}, ${imports.add(model)})`)
    }
    this.leave(action.id, 'response', `the stub answers 501 until the http step writes ${describeResponse(this.plan, action.response)}`)
    lines.push(`    throw HttpException.notImplemented(${quoteString(`${controller.className}.${action.name} is planned and not written yet`)})`)
    return {
      name: action.name,
      comment: [`Planned response: ${describeResponse(this.plan, action.response)}`, ...action.rules.map((rule) => `Rule: ${oneLine(rule)}`)],
      body: lines.join('\n'),
    }
  }

  controller(controller: PlanController, actions: readonly PlanAction[], model: PlanModel): string {
    const path = controllerFilePath(controller)
    const imports = new Imports(path)
    const sources = actions.map((action) => this.action(controller, action, imports))
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
