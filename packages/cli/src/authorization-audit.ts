/**
 * Policy authorization on mutating routes: an action on a non-safe method whose
 * body names a Model the app keeps a policy for must show an authorization
 * decision, or the policy is a file nothing consults. A policy is found by the
 * name `make:policy` writes (`app/Policies/<Model>Policy.ts`, modules included),
 * not by the `gate.policy(Model, Policy)` call that binds it. Advisory: the
 * decision may sit in a service the action calls, which the body scan cannot follow.
 */
import { resolve } from 'node:path'
import type { RouteDefinition } from '@guren/server'
import type { AuditFinding } from './audit'
import { AUTHORIZATION_CALL_PATTERN, type ControllerMethodInfo } from './controller-methods'
import { classNameFromPath, discoverModelFiles, discoverPolicyFiles } from './discovery'
import { describeMethod } from './http-methods'
import { extractClassDeclaration } from './model-parser'
import type { ParseCache } from './parse-cache'
import { readPolicyAbilities } from './plan/policy-abilities'
import { escapeRegExp } from './utils'

/**
 * Guest flows (login, registration, password reset), reachable without a
 * principal: neither the authentication rule nor this one asks them for a check.
 */
export const GUEST_PATH_PATTERN = /(login|logout|register|signup|sign-up|password|forgot|reset|verification|verify-email)/i

const POLICY_SUFFIX = 'Policy'

interface PolicyBinding {
  model: string
  policy: string
  /** Ability names the policy declares; absent when the file could not be read as a policy. */
  abilities?: string[]
}

/** A whole identifier, so `Post` is not found inside `PostTag` or `this.Post`. */
function identifierPattern(name: string): RegExp {
  return new RegExp(`(?<![\\w$.])${escapeRegExp(name)}(?![\\w$])`)
}

async function modelNames(cwd: string, cache: ParseCache): Promise<Set<string>> {
  const names = new Set<string>()
  for (const filePath of await discoverModelFiles(cwd)) {
    const parsed = await cache.get(filePath)
    let declared = false
    for (const statement of parsed?.ast.program.body ?? []) {
      const classDecl = extractClassDeclaration(statement)
      if (!classDecl?.id) continue
      names.add(classDecl.id.name)
      declared = true
    }
    // A model file that would not parse still names its model: the rule fails
    // closed on the policy side, so the model side must not drop it.
    if (!declared) names.add(classNameFromPath(filePath))
  }
  return names
}

/** Model → the policy `<Model>Policy` under an app root's `app/Policies`. */
async function policyBindings(cwd: string, cache: ParseCache): Promise<PolicyBinding[]> {
  const policyFiles = await discoverPolicyFiles(cwd)
  if (policyFiles.length === 0) return []

  const models = await modelNames(cwd, cache)
  const bindings: PolicyBinding[] = []
  for (const filePath of policyFiles) {
    const policy = classNameFromPath(filePath)
    if (!policy.endsWith(POLICY_SUFFIX)) continue
    const model = policy.slice(0, -POLICY_SUFFIX.length)
    if (!models.has(model)) continue

    const parsed = await cache.get(filePath)
    const abilities = parsed ? readPolicyAbilities(parsed.ast, policy) : null
    bindings.push({
      model,
      policy,
      ...(abilities && !('unreadable' in abilities) ? { abilities: abilities.declared } : {}),
    })
  }
  return bindings
}

/** `// guren-audit-ignore` on the action's declaration line or the line above it. */
async function suppressed(cwd: string, cache: ParseCache, info: ControllerMethodInfo): Promise<boolean> {
  const lines = (await cache.source(resolve(cwd, info.filePath)))?.split('\n') ?? []
  return [lines[info.line - 1], lines[info.line - 2]].some((text) => text?.includes('guren-audit-ignore'))
}

function describeBindings(bindings: PolicyBinding[]): string {
  return bindings.map((binding) => `${binding.model} (${binding.policy})`).join(', ')
}

function authorizeSuggestion(controllerKey: string, { model, policy, abilities }: PolicyBinding): string {
  const instance = model.charAt(0).toLowerCase() + model.slice(1)
  const declared = abilities === undefined
    ? `${policy} could not be read as a policy, so its abilities are not listed here`
    : abilities.length > 0
      ? `${policy} declares ${abilities.join(', ')}`
      : `${policy} declares no ability yet`
  return (
    `Call await this.authorize('<ability>', [${model}, ${instance}]) in ${controllerKey} before the write `
    + `(${declared}), or attach authorize()/authorizeResource() middleware to the route. If a service the `
    + `action calls consults the policy, put // guren-audit-ignore above the action, or ignore the finding by `
    + `key in config/audit.ts with the reason.`
  )
}

/**
 * One finding per mutating controller route, keyed `authorization:<METHOD> <path>`,
 * once the app has at least one policy; an app with none contributes nothing.
 * Route-level, so `config/audit.ts` is its suppression, and the inline marker
 * on the action is honoured as well since the action is where the fix goes.
 */
export async function auditAuthorization(
  cwd: string,
  definitions: RouteDefinition[] | undefined,
  controllerMethods: ReadonlyMap<string, ControllerMethodInfo>,
  cache: ParseCache,
  findings: AuditFinding[],
): Promise<void> {
  if (!definitions) return
  const bindings = await policyBindings(cwd, cache)
  if (bindings.length === 0) return

  for (const route of definitions) {
    const method = route.method.toUpperCase()
    if (describeMethod(method).safe || !route.controller || GUEST_PATH_PATTERN.test(route.path)) continue

    const routeLabel = `${method} ${route.path}`
    const key = `authorization:${routeLabel}`
    const controllerKey = `${route.controller.name}.${route.controller.action}`
    const push = (status: AuditFinding['status'], message: string, suggestion?: string, filePath?: string) =>
      findings.push({ key, title: routeLabel, status, message, suggestion, filePath })

    // Presence, not derivability, as in the agent-route rule: a `mixed` chain
    // still authorizes, whatever ability it resolves.
    if (route.capabilities?.authorization) {
      push('pass', 'Authorized by middleware (verified via middleware capabilities).')
      continue
    }

    const info = controllerMethods.get(controllerKey)
    if (!info) {
      push(
        'warn',
        `Authorization could not be verified: ${controllerKey} is not among the controller sources the `
        + `audit reads, and the app keeps a policy for ${describeBindings(bindings)}.`,
        `Ensure ${controllerKey} is under app/Http/Controllers (or a module's), or attach `
        + 'authorize()/authorizeResource() middleware to the route so the chain carries the decision.',
      )
      continue
    }

    const touched = bindings.filter((binding) => identifierPattern(binding.model).test(info.body))
    if (touched.length === 0) {
      push('pass', `${controllerKey} references no model the app keeps a policy for.`)
      continue
    }

    const consultsPolicy =
      AUTHORIZATION_CALL_PATTERN.test(info.body)
      || touched.some((binding) => identifierPattern(binding.policy).test(info.body))
    if (consultsPolicy) {
      push('pass', `${controllerKey} consults a policy for ${describeBindings(touched)}.`)
      continue
    }

    if (await suppressed(cwd, cache, info)) continue
    push(
      'warn',
      `${controllerKey} (${info.filePath}:${info.line}) references ${describeBindings(touched)} on a mutating `
      + 'route, and neither the middleware chain nor the action body shows an authorization check: every '
      + 'caller the route admits reaches the write.',
      authorizeSuggestion(controllerKey, touched[0]!),
      info.filePath,
    )
  }
}
