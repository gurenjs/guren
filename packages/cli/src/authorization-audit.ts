/**
 * Policy authorization on mutating routes: an action on a non-safe method whose
 * body names a Model the app keeps a policy for must show an authorization
 * decision, or the policy is a file nothing consults. A policy is paired with
 * its model by the name `make:policy` writes (`app/Policies/<Model>Policy.ts`,
 * within one app root), not by the `gate.policy(Model, Policy)` call that binds
 * it. Advisory: a service or helper the action calls is not followed, and the
 * guest paths the authentication rule skips are skipped here too.
 */
import { resolve } from 'node:path'
import type { RouteDefinition } from '@guren/server'
import type { AuditFinding } from './audit'
import { AUTHORIZATION_CALL_PATTERN, type ControllerMethodInfo } from './controller-methods'
import { classNameFromPath, discoverPolicyFiles, moduleNameFromRelPath, toPosixRelative } from './discovery'
import { describeMethod } from './http-methods'
import { discoverModelClasses } from './model-parser'
import type { ParseCache } from './parse-cache'
import { readPolicyAbilities } from './plan/policy-abilities'
import { importsByLocal, specifierBase, withoutExtension } from './schema-binding'
import { camelCase, escapeRegExp, wholeIdentifierPattern } from './utils'

/**
 * Guest flows (login, registration, password reset), reachable without a
 * principal: neither the authentication rule nor this one asks them for a check.
 */
export const GUEST_PATH_PATTERN = /(login|logout|register|signup|sign-up|password|forgot|reset|verification|verify-email)/i

/**
 * A gate consulted by hand, the form the authorization guide documents beside
 * `this.authorize()`: `gate.allows(...)` on a `this.make('gate').forUser(user)`.
 * `forUser` counts because the string the gate is made with is blanked away.
 */
const GATE_CALL_PATTERN = /\b[gG]ate\s*\.\s*(?:allows|denies|any|all|none|authorize|inspect|check|forUser)\s*\(/

const AUDIT_IGNORE_MARKER = 'guren-audit-ignore'

const POLICY_SUFFIX = 'Policy'

interface PolicyBinding {
  model: string
  policy: string
  /** Absolute path of the model file, which a controller's imports are resolved against. */
  modelFile: string
  /** Absolute path of the policy file. */
  policyFile: string
  policyPattern: RegExp
}

async function policyBindings(cwd: string, cache: ParseCache): Promise<PolicyBinding[]> {
  const policyFiles = await discoverPolicyFiles(cwd)
  if (policyFiles.length === 0) return []

  // Keyed by app root as well as name: `make:adr` and `plan` pair a module's
  // model with that module's policy, and this rule must not disagree with them.
  const models = new Map(
    (await discoverModelClasses(cwd, cache)).map(({ module, className, filePath }) => [`${module ?? ''}/${className}`, filePath]),
  )
  const bindings: PolicyBinding[] = []
  for (const policyFile of policyFiles) {
    const policy = classNameFromPath(policyFile)
    if (!policy.endsWith(POLICY_SUFFIX)) continue
    const model = policy.slice(0, -POLICY_SUFFIX.length)
    const modelFile = models.get(`${moduleNameFromRelPath(toPosixRelative(cwd, policyFile)) ?? ''}/${model}`)
    if (modelFile === undefined) continue
    bindings.push({ model, policy, modelFile, policyFile, policyPattern: wholeIdentifierPattern(policy) })
  }
  return bindings
}

/**
 * How one controller file may spell each model: the bare class name always
 * (an import through a barrel resolves to no file), plus what the file imports
 * the model's module as, so `import { Post as PostModel }`, a default import
 * and `Models.Post` under `import * as Models` are references too.
 */
async function modelPatterns(
  cwd: string,
  controllerFile: string,
  bindings: PolicyBinding[],
  cache: ParseCache,
): Promise<Map<PolicyBinding, RegExp[]>> {
  const patterns = new Map(bindings.map((binding) => [binding, [wholeIdentifierPattern(binding.model)]]))
  const parsed = await cache.get(controllerFile)
  if (!parsed) return patterns

  for (const [local, entry] of importsByLocal(parsed.ast.program.body)) {
    const base = specifierBase(cwd, controllerFile, entry.source)
    if (base === null) continue
    for (const binding of bindings) {
      if (withoutExtension(base) !== withoutExtension(binding.modelFile)) continue
      if (entry.kind === 'namespace') {
        patterns.get(binding)!.push(new RegExp(`(?<![\\w$.])${escapeRegExp(local)}\\s*\\.\\s*${escapeRegExp(binding.model)}(?![\\w$])`))
      } else if (entry.kind === 'default' || entry.imported === binding.model) {
        patterns.get(binding)!.push(wholeIdentifierPattern(local))
      }
    }
  }
  return patterns
}

function describeBindings(bindings: PolicyBinding[]): string {
  return bindings.map((binding) => `${binding.model} (${binding.policy})`).join(', ')
}

async function authorizeSuggestion(
  controllerKey: string,
  { model, policy, policyFile }: PolicyBinding,
  cache: ParseCache,
): Promise<string> {
  const parsed = await cache.get(policyFile)
  const abilities = parsed ? readPolicyAbilities(parsed.ast, policy) : null
  const declared = abilities && !('unreadable' in abilities)
    ? `${policy} declares ${abilities.declared.join(', ') || 'no ability yet'}`
    : `${policy} could not be read as a policy`
  return (
    `Call await this.authorize('<ability>', [${model}, ${camelCase(model)}]) in ${controllerKey} before the write `
    + `(${declared}), or attach authorize()/authorizeResource() middleware to the route. A helper the action `
    + 'calls is not read: if it authorizes there, say so in a // guren-audit-ignore comment above the action.'
  )
}

/**
 * One finding per mutating controller route, keyed `policy:<METHOD> <path>`,
 * once the app has at least one policy; an app with none contributes nothing.
 * Route-level on purpose: the finding carries no `line`, so `config/audit.ts`
 * ignores it by key (a `line` would make every such entry `unsupported`); a
 * `// guren-audit-ignore` comment above the action reports it `ignored` instead.
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
  const patternsByFile = new Map<string, Map<PolicyBinding, RegExp[]>>()

  for (const route of definitions) {
    const method = route.method.toUpperCase()
    if (describeMethod(method).safe || !route.controller || GUEST_PATH_PATTERN.test(route.path)) continue

    const routeLabel = `${method} ${route.path}`
    const controllerKey = `${route.controller.name}.${route.controller.action}`
    const push = (status: AuditFinding['status'], message: string, rest: Partial<AuditFinding> = {}) =>
      findings.push({ key: `policy:${routeLabel}`, title: routeLabel, status, message, ...rest })

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
        + `audit reads, and the app keeps ${bindings.length} model polic${bindings.length === 1 ? 'y' : 'ies'}.`,
        {
          suggestion: `Ensure ${controllerKey} is under app/Http/Controllers (or a module's), or attach `
            + 'authorize()/authorizeResource() middleware to the route so the chain carries the decision.',
        },
      )
      continue
    }

    const controllerFile = resolve(cwd, info.filePath)
    let patterns = patternsByFile.get(controllerFile)
    if (!patterns) {
      patterns = await modelPatterns(cwd, controllerFile, bindings, cache)
      patternsByFile.set(controllerFile, patterns)
    }
    const touched = bindings.filter((binding) => patterns!.get(binding)!.some((pattern) => pattern.test(info.body)))
    if (touched.length === 0) {
      push(
        'pass',
        `${controllerKey} names no model the app keeps a policy for; a write through a service or a `
        + 'relationship is not judged.',
      )
      continue
    }
    if (
      AUTHORIZATION_CALL_PATTERN.test(info.body)
      || GATE_CALL_PATTERN.test(info.body)
      || touched.some((binding) => binding.policyPattern.test(info.body))
    ) {
      push('pass', `${controllerKey} consults a policy for ${describeBindings(touched)}.`)
      continue
    }

    const message =
      `${controllerKey} (${info.filePath}:${info.line}) references ${describeBindings(touched)} on a mutating `
      + 'route, and neither the middleware chain nor the action body shows an authorization check.'
    const marker = info.leadingComments.find((comment) => comment.includes(AUDIT_IGNORE_MARKER))
    if (marker !== undefined) {
      push('ignored', message, { ignoreReason: marker, filePath: info.filePath })
      continue
    }
    push('warn', message, {
      suggestion: await authorizeSuggestion(controllerKey, touched[0]!, cache),
      filePath: info.filePath,
    })
  }
}
