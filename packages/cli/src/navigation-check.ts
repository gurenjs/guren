/**
 * `guren check`'s navigation readings (RFC 0040 §5), advisory throughout and content-activated
 * on `config/navigation.ts`, read through `readNavigationFile()`. An entry's route is judged
 * against the introspected app, a provider's routes included: the route the runtime would hide
 * (missing, not a `GET`, a path parameter) and the one it cannot see, a route that renders no
 * page. Then, since hiding a link protects nothing, the entry against what its route does: a
 * link everyone sees to a route that requires sign-in, an ability the action authorizes that the
 * entry does not ask, and a `can` the gate cannot answer without a record.
 */
import { resolve } from 'node:path'
import type { AppManifest, RouteDefinition, RouteEntry } from '@guren/server'

import { modelPatterns, policyBindings, type PolicyBinding } from './authorization-audit'
import { advisory, type CheckResult } from './check-result'
import {
  collisionsReachedByName,
  CONTROLLER_MEMBER_KINDS,
  controllerMethodFor,
  literalAuthorizationCalls,
  manifestRouteTargets,
  parseControllerMethods,
  routeSourceClasses,
  type ControllerMethodInfo,
  type ControllerMethodScan,
  type ControllerTarget,
} from './controller-methods'
import { NAVIGATION_CONFIG_FILE, toPosixRelative } from './discovery'
import { introspectedRoutes, unverifiedResult, type IntrospectSource } from './manifest-section'
import { readNavigationFile, type NavigationFileEntry } from './navigation-file'
import type { ParseCache } from './parse-cache'
import { readPolicyAbilities, readPolicyAbilityParameters } from './plan/policy-abilities'
import { manifestAuthVerdict } from './route-auth'
import { withoutExtension } from './schema-binding'
import { isParameterless } from './utils'

export interface NavigationCheckOptions {
  cwd: string
  cache: ParseCache
  /** The routes file's registered definitions, judged only when the app could not be introspected. */
  definitions?: RouteDefinition[]
  /** The routes entry, whose classes a `name-only` manifest reference may name. */
  routesFile: string
  introspect?: IntrospectSource
}

type NavigationRoute = Pick<RouteDefinition, 'method' | 'path' | 'name' | 'prototype'> & {
  controller?: ControllerTarget
  middleware?: RouteEntry['middleware']
}

interface Routes {
  routes: NavigationRoute[]
  /** The manifest the routes came from; absent when they are the routes file's definitions. */
  manifest?: AppManifest
  /** Why the introspected app was not read; absent when it was, or when no reason is given. */
  reason?: string
}

const TITLE = (entry: NavigationFileEntry): string => `Navigation entry "${entry.label}"`

const INERTIA_CALL = /\bthis\s*\.\s*inertia\s*\(/u
const THIS_CALL = /\bthis\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/gu

export async function checkNavigation(options: NavigationCheckOptions): Promise<CheckResult[]> {
  const { cwd, cache } = options
  const file = resolve(cwd, NAVIGATION_CONFIG_FILE)
  const outcome = await cache.read(file)
  if (outcome.status === 'unreadable') return []
  if (outcome.status !== 'parsed') {
    return [advisory('navigation-file', 'Navigation', 'warn', `${NAVIGATION_CONFIG_FILE} does not parse, so its entries are not checked.`, undefined, NAVIGATION_CONFIG_FILE)]
  }
  const reading = readNavigationFile(outcome.ast, { cwd, file })
  if (reading.status === 'not-a-definition') return []
  if (reading.status === 'unreadable') {
    const at = reading.line ? ` (line ${reading.line})` : ''
    return [advisory(
      'navigation-file', 'Navigation', 'warn',
      `${NAVIGATION_CONFIG_FILE} is not read${at}: ${reading.reason}. The navigation checks did not run.`,
      'Write each entry in place, as { label, route, show }, with literal values and a model class in show.can.',
      NAVIGATION_CONFIG_FILE,
    )]
  }
  if (reading.entries.length === 0) return []

  const routes = await navigationRoutes(options)
  const context = new EntryContext(options, routes)
  const results: CheckResult[] = []
  for (const entry of reading.entries) results.push(...(await context.judge(entry)))
  if (!routes.manifest) results.push(...signInUnverified(reading.entries.filter((entry) => context.linked.has(entry.route)), routes.reason))
  return results
}

async function navigationRoutes({ cwd, cache, definitions, routesFile, introspect }: NavigationCheckOptions): Promise<Routes> {
  const introspected = await introspectedRoutes(introspect)
  if (introspected.status === 'described') {
    const { manifest } = introspected
    const targets = manifestRouteTargets(manifest, await routeSourceClasses(cwd, manifest, routesFile, cache))
    return { routes: targets, manifest }
  }
  const reason = introspected.reason ?? (introspected.failure ? `introspection failed (${introspected.failure.reason})` : undefined)
  return { routes: definitions ?? [], ...(reason ? { reason } : {}) }
}

/** The entries a guest may see whose sign-in the manifest would have judged: one line, not one per entry. */
function signInUnverified(entries: NavigationFileEntry[], reason: string | undefined): CheckResult[] {
  const shown = entries.filter(shownToGuests)
  if (shown.length === 0) return []
  return [unverifiedResult(
    'navigation-sign-in-unverified', 'Navigation',
    `Whether the routes of ${shown.map((entry) => `"${entry.route}"`).join(', ')} require sign-in`,
    reason,
    { detail: 'Their entries are shown to guests, and only the resolved middleware says whether a guest can open them.', filePath: NAVIGATION_CONFIG_FILE },
  )]
}

/** Shown to a visitor who is not signed in: no `auth: 'required'`, no `where` (which a guest never matches), and no `can` the gate decides. */
function shownToGuests(entry: NavigationFileEntry): boolean {
  return entry.auth !== 'required' && entry.where === undefined && entry.can === undefined
}

interface NameableCall {
  ability: string
  binding: PolicyBinding
}

class EntryContext {
  private scan?: Promise<ControllerMethodScan>
  private bindings?: Promise<PolicyBinding[]>
  /** The routes of the entries the runtime would link: the ones the sign-in reading is asked of. */
  readonly linked = new Set<string>()

  constructor(private readonly options: NavigationCheckOptions, private readonly routes: Routes) {}

  private controllers(): Promise<ControllerMethodScan> {
    return (this.scan ??= parseControllerMethods(this.options.cwd, this.options.cache))
  }

  private policies(): Promise<PolicyBinding[]> {
    return (this.bindings ??= policyBindings(this.options.cwd, this.options.cache))
  }

  async judge(entry: NavigationFileEntry): Promise<CheckResult[]> {
    const findings: CheckResult[] = []
    const route = this.route(entry, findings)
    if (entry.can) findings.push(...(await this.canFindings(entry)))
    if (route) {
      this.linked.add(entry.route)
      findings.push(...(await this.routeFindings(entry, route)))
    }
    if (findings.length > 0) return findings
    return [advisory(`navigation:${entry.route}`, TITLE(entry), 'pass', `Links route "${entry.route}" (GET ${route?.path}), which renders a page.`, undefined, NAVIGATION_CONFIG_FILE)]
  }

  /** The route the runtime links the entry to, or `undefined` with why it would not, or why that is not known. */
  private route(entry: NavigationFileEntry, findings: CheckResult[]): NavigationRoute | undefined {
    const key = `navigation-route:${entry.route}`
    const named = this.routes.routes.filter((route) => route.name === entry.route)
    if (named.length === 0) {
      findings.push(this.routes.manifest
        ? advisory(key, TITLE(entry), 'warn', `Route "${entry.route}" is not registered, so the runtime hides the entry.`, 'Name the route the entry links to, or remove the entry.', NAVIGATION_CONFIG_FILE)
        : unverifiedResult(key, TITLE(entry), `Route "${entry.route}"`, this.routes.reason, {
          detail: 'The routes file registers no route of that name, and a provider or module may.',
          filePath: NAVIGATION_CONFIG_FILE,
        }))
      return undefined
    }
    if (named.length > 1) {
      findings.push(advisory(
        key, TITLE(entry), 'warn',
        `${named.length} routes are named "${entry.route}" (${named.map((route) => `${route.method} ${route.path}`).join(', ')}). The entry links the one Router.route() gives, the route named last, and the order .name() ran in is not read, so the entry is not checked.`,
        'Give each route its own name.', NAVIGATION_CONFIG_FILE,
      ))
      return undefined
    }
    const route = named[0]!
    if (route.method !== 'GET') {
      findings.push(advisory(key, TITLE(entry), 'warn', `Route "${entry.route}" is a ${route.method} route, and a link can only follow a GET, so the runtime hides the entry.`, 'Link a GET route that renders the page.', NAVIGATION_CONFIG_FILE))
      return undefined
    }
    if (!isParameterless(route.path)) {
      findings.push(advisory(key, TITLE(entry), 'warn', `Route "${entry.route}" has a path parameter (${route.path}), which an entry cannot fill, so the runtime hides the entry.`, 'Link a route with no parameter, such as the index the record is reached from.', NAVIGATION_CONFIG_FILE))
      return undefined
    }
    return route
  }

  private async routeFindings(entry: NavigationFileEntry, route: NavigationRoute): Promise<CheckResult[]> {
    const findings: CheckResult[] = []
    if (this.routes.manifest && shownToGuests(entry)) {
      const finding = signInFinding(entry, route)
      if (finding) findings.push(finding)
    }
    if (route.prototype) return findings
    const action = await this.action(entry, route)
    if ('unread' in action) return [...findings, action.unread]
    const { info } = action
    if (!INERTIA_CALL.test(info.body)) {
      const helper = helperCall(info.body)
      findings.push(helper
        ? advisory(`navigation-action:${entry.route}`, TITLE(entry), 'warn', `Whether route "${entry.route}" renders a page is unverified: its action calls this.${helper}(), which is not read.`, undefined, info.filePath)
        : advisory(`navigation-page:${entry.route}`, TITLE(entry), 'warn', `Route "${entry.route}" renders no page: its action (${info.filePath}:${info.line}) makes no this.inertia() call, so the link leads to a redirect or a response no layout wraps.`, 'Link the route that renders the page the entry is for.', NAVIGATION_CONFIG_FILE))
    }
    findings.push(...(await this.abilityFindings(entry, info)))
    return findings
  }

  private async action(entry: NavigationFileEntry, route: NavigationRoute): Promise<{ info: ControllerMethodInfo } | { unread: CheckResult }> {
    const unread = (why: string): { unread: CheckResult } => ({
      unread: advisory(`navigation-action:${entry.route}`, TITLE(entry), 'warn', `Whether route "${entry.route}" renders a page, and what it authorizes, is unverified: ${why}.`, undefined, NAVIGATION_CONFIG_FILE),
    })
    if (!route.controller) return unread('its handler is inline, and an inline handler is not read')
    const scan = await this.controllers()
    const lookup = controllerMethodFor(scan, route.controller)
    if (lookup.by === 'name' && collisionsReachedByName(scan, [route.controller]).length > 0) {
      return unread(`more than one controller file declares ${lookup.className}`)
    }
    if (!lookup.info) return unread(`the body of ${lookup.className}.${route.controller.action} is not found in a controller file`)
    return { info: lookup.info }
  }

  /** The action's `this.authorize()` calls an entry could name, against the entry's `can`. */
  private async abilityFindings(entry: NavigationFileEntry, info: ControllerMethodInfo): Promise<CheckResult[]> {
    const key = `navigation-ability:${entry.route}`
    const calls = literalAuthorizationCalls(info.body, info.rawBody).filter((call) => call.member === 'authorize')
    if (calls.length === 0) return []
    if (calls.some((call) => call.templated)) {
      return [advisory(key, TITLE(entry), 'warn', `What route "${entry.route}" authorizes is unverified: its action builds an ability name at request time.`, undefined, info.filePath)]
    }
    const nameable = await this.nameableCalls(calls.map((call) => ({ ability: call.ability, subject: call.subject })), info)
    if (nameable.length === 0) return []
    const named = nameable.map((call) => `'${call.ability}' on ${call.binding.model}`).join(', ')
    if (!entry.can) {
      const where = entry.where ? ' Its where condition may restate the policy\'s rule in the layout\'s terms.' : ''
      const [first] = nameable
      return [advisory(
        key, TITLE(entry), 'warn',
        `The action of route "${entry.route}" (${info.filePath}:${info.line}) authorizes ${named}, and the entry does not ask it, so a user the policy denies sees a link that answers 403.${where}`,
        `Add show: { can: ['${first!.ability}', ${first!.binding.model}] } to the entry.`,
        NAVIGATION_CONFIG_FILE,
      )]
    }
    const asked = entry.can
    const paired = await this.canBinding(asked)
    if ('unread' in paired) return []
    if (nameable.some((call) => call.ability === asked.ability && call.binding === paired.binding)) return []
    return [advisory(
      key, TITLE(entry), 'warn',
      `The entry asks '${asked.ability}' on ${asked.model.expression}, and the action of route "${entry.route}" (${info.filePath}:${info.line}) authorizes ${named}, so the link and the page can disagree.`,
      'Name in show.can the ability the action authorizes.',
      NAVIGATION_CONFIG_FILE,
    )]
  }

  /** Calls whose subject is exactly a model with a policy, on an ability that takes the user alone. */
  private async nameableCalls(calls: Array<{ ability: string; subject: string }>, info: ControllerMethodInfo): Promise<NameableCall[]> {
    const bindings = await this.policies()
    if (bindings.length === 0) return []
    const { cwd, cache } = this.options
    const patterns = await modelPatterns(cwd, resolve(cwd, info.filePath), bindings, cache)
    const nameable: NameableCall[] = []
    for (const call of calls) {
      const binding = bindings.find((candidate) => patterns.get(candidate)!.some((pattern) => wholly(pattern, call.subject)))
      if (!binding) continue
      const parameters = await this.parameters(binding, call.ability)
      if (Array.isArray(parameters) && parameters.length <= 1 && !parameters.includes('rest')) nameable.push({ ability: call.ability, binding })
    }
    return nameable
  }

  private async parameters(binding: PolicyBinding, ability: string): Promise<ReturnType<typeof readPolicyAbilityParameters>> {
    const parsed = await this.options.cache.get(binding.policyFile)
    return parsed ? readPolicyAbilityParameters(parsed.ast, binding.policy, ability) : { unreadable: `${binding.policyFile} does not parse` }
  }

  /**
   * The policy paired with the `can` model's file, `undefined` when none pairs with its class name,
   * or why the pairing is not read: a class from a package, or one imported through a barrel.
   */
  private async canBinding(can: NonNullable<NavigationFileEntry['can']>): Promise<{ binding: PolicyBinding | undefined } | { unread: string }> {
    const named = (await this.policies()).filter((candidate) => candidate.model === can.model.className)
    if (named.length === 0) return { binding: undefined }
    if (!can.model.module) return { unread: `${can.model.expression} is not imported from a file of the app` }
    const binding = named.find((candidate) => sameModule(can.model.module, candidate.modelFile))
    return binding ? { binding } : { unread: `${can.model.expression} is imported from ${toPosixRelative(this.options.cwd, can.model.module)}, not from the model's own file` }
  }

  /** The `can` against the policy the gate would ask: a required record, an optional one, or no such ability. */
  private async canFindings(entry: NavigationFileEntry): Promise<CheckResult[]> {
    const can = entry.can!
    const key = `navigation-can:${entry.route}`
    const unverified = (why: string): CheckResult[] => [advisory(key, TITLE(entry), 'warn', `Whether the gate can answer '${can.ability}' on ${can.model.expression} for the entry is unverified: ${why}.`, undefined, NAVIGATION_CONFIG_FILE)]
    const paired = await this.canBinding(can)
    if ('unread' in paired) return unverified(paired.unread)
    const { binding } = paired
    if (!binding) {
      return [advisory(
        key, TITLE(entry), 'warn',
        `No app/Policies/${can.model.className}Policy.ts pairs with ${can.model.expression}, so the gate asks a gate.define('${can.ability}') ability, and with none denies everyone and hides the entry.`,
        `Write the policy with bunx guren make:policy ${can.model.className}, or define the ability with gate.define('${can.ability}', …).`,
        NAVIGATION_CONFIG_FILE,
      )]
    }
    const policyFile = toPosixRelative(this.options.cwd, binding.policyFile)
    const parsed = await this.options.cache.get(binding.policyFile)
    if (!parsed) return unverified(`${policyFile} does not parse`)
    const abilities = readPolicyAbilities(parsed.ast, binding.policy)
    if ('unreadable' in abilities) return unverified(abilities.unreadable)
    if (abilities.exposes && !abilities.exposes.includes(can.ability)) {
      return [advisory(key, TITLE(entry), 'warn', `${binding.policy} is a definePolicy() policy, whose class has no '${can.ability}', so the gate never asks it and the entry is hidden unless a gate.define('${can.ability}') allows it.`, `Name one of ${abilities.exposes.join(', ')}.`, NAVIGATION_CONFIG_FILE)]
    }
    if (!abilities.declared.includes(can.ability)) {
      if (abilities.fields.includes(can.ability)) return unverified(`${binding.policy}.${can.ability} is not a function written in place`)
      if (abilities.open) return unverified(`${binding.policy} may declare it: ${abilities.open}`)
      return [advisory(key, TITLE(entry), 'warn', `${binding.policy} declares no '${can.ability}', so the gate asks a gate.define('${can.ability}') ability, and with none denies everyone and hides the entry.`, `Add ${can.ability}(user) to ${policyFile}.`, NAVIGATION_CONFIG_FILE)]
    }
    const parameters = readPolicyAbilityParameters(parsed.ast, binding.policy, can.ability)
    if (parameters === undefined) return []
    if (!Array.isArray(parameters)) return unverified(parameters.unreadable)
    const second = parameters[1]
    if (second === 'required') {
      return [advisory(
        key, TITLE(entry), 'warn',
        `${binding.policy}.${can.ability} requires a second parameter, and an entry has no record to give it: the gate calls it with the user alone, so it reads undefined.`,
        `Name an ability that takes the user alone, such as viewAny or create.`,
        NAVIGATION_CONFIG_FILE,
      )]
    }
    if (second !== undefined) return unverified(`${binding.policy}.${can.ability} takes a second parameter it may go without, and what it means without one is not read`)
    return []
  }
}

function signInFinding(entry: NavigationFileEntry, route: NavigationRoute): CheckResult | undefined {
  if (!route.middleware) return undefined
  const verdict = manifestAuthVerdict({ middleware: route.middleware })
  const key = `navigation-sign-in:${entry.route}`
  const who = entry.auth === 'guest' ? 'only to guests' : 'to everyone'
  if (verdict.verdict === 'verified') {
    return advisory(
      key, TITLE(entry), 'warn',
      `The entry is shown ${who}, and route "${entry.route}" requires sign-in, so a guest follows the link to the sign-in page.`,
      entry.auth === 'guest' ? 'Remove the entry, or link a route a guest can open.' : 'Add show: { auth: \'required\' } to the entry.',
      NAVIGATION_CONFIG_FILE,
    )
  }
  if (verdict.unresolved.length > 0 || verdict.verdict === 'unverified-auth-name') {
    const names = [...verdict.unresolved, ...verdict.names].map((name) => `"${name}"`).join(', ')
    return advisory(key, TITLE(entry), 'warn', `Whether route "${entry.route}" requires sign-in is unverified: its middleware ${names} carries no capability that says so.`, undefined, NAVIGATION_CONFIG_FILE)
  }
  return undefined
}

/** A `this.<name>()` call to anything but a member of `Controller`: a helper of the class, whose body is not read. */
function helperCall(body: string): string | undefined {
  for (const match of body.matchAll(THIS_CALL)) {
    if (!Object.hasOwn(CONTROLLER_MEMBER_KINDS, match[1]!)) return match[1]
  }
  return undefined
}

function wholly(pattern: RegExp, subject: string): boolean {
  const match = pattern.exec(subject)
  return match !== null && match.index === 0 && match[0].length === subject.length
}

function sameModule(module: string | undefined, file: string): boolean {
  return module !== undefined && module === withoutExtension(file)
}
