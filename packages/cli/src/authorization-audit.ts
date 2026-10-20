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
import type { AuditedRoute, AuditFinding } from './audit'
import type { CheckEvidence } from './check-result'
import {
  consultsAuthorization,
  controllerMethodFor,
  literalAbilities,
  type ControllerMethodScan,
} from './controller-methods'
import { classNameFromPath, discoverPolicyFiles, moduleNameFromRelPath, toPosixRelative } from './discovery'
import { describeMethod } from './http-methods'
import { discoverModelClasses } from './model-parser'
import type { ParseCache } from './parse-cache'
import { readPolicyAbilities } from './plan/policy-abilities'
import { importsByLocal, specifierBase, withoutExtension, type ImportEntry } from './schema-binding'
import { camelCase, escapeRegExp, wholeIdentifierPattern } from './utils'

/**
 * Guest flows (login, registration, password reset), reachable without a
 * principal: neither the authentication rule nor this one asks them for a check.
 */
export const GUEST_PATH_PATTERN = /(login|logout|register|signup|sign-up|password|forgot|reset|verification|verify-email)/i

const AUDIT_IGNORE_MARKER = 'guren-audit-ignore'

const POLICY_SUFFIX = 'Policy'

export interface PolicyBinding {
  model: string
  policy: string
  /** Absolute path of the model file, which a controller's imports are resolved against. */
  modelFile: string
  /** Absolute path of the policy file. */
  policyFile: string
  policyPattern: RegExp
}

export async function policyBindings(cwd: string, cache: ParseCache): Promise<PolicyBinding[]> {
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
 * How a file spells each class it imports from `targetFile` (absolute): the local
 * name of a named import of `className` or of a default import, or `namespace.Class`.
 * A type-only import, or one through a barrel (which names the barrel, not `targetFile`), yields nothing.
 */
export function importReferencePatterns(
  cwd: string,
  importer: string,
  imports: Map<string, ImportEntry>,
  targetFile: string,
  className: string,
): RegExp[] {
  const patterns: RegExp[] = []
  for (const [local, entry] of imports) {
    if (entry.typeOnly) continue
    const base = specifierBase(cwd, importer, entry.source)
    if (base === null || withoutExtension(base) !== withoutExtension(targetFile)) continue
    if (entry.kind === 'namespace') {
      patterns.push(new RegExp(`(?<![\\w$.])${escapeRegExp(local)}\\s*\\.\\s*${escapeRegExp(className)}(?![\\w$])`))
    } else if (entry.kind === 'default' || entry.imported === className) {
      patterns.push(wholeIdentifierPattern(local))
    }
  }
  return patterns
}

/**
 * How one controller file may spell each model: the bare class name always
 * (an import through a barrel resolves to no file), plus what the file imports
 * the model's module as, so `import { Post as PostModel }`, a default import
 * and `Models.Post` under `import * as Models` are references too.
 */
export async function modelPatterns(
  cwd: string,
  controllerFile: string,
  bindings: PolicyBinding[],
  cache: ParseCache,
): Promise<Map<PolicyBinding, RegExp[]>> {
  const parsed = await cache.get(controllerFile)
  const imports = parsed ? importsByLocal(parsed.ast.program.body) : new Map<string, ImportEntry>()
  return new Map(bindings.map((binding) => [binding, [
    wholeIdentifierPattern(binding.model),
    ...importReferencePatterns(cwd, controllerFile, imports, binding.modelFile, binding.model),
  ]]))
}

function describeBindings(bindings: PolicyBinding[]): string {
  return bindings.map((binding) => `${binding.model} (${binding.policy})`).join(', ')
}

async function authorizeSuggestion(
  controllerKey: string,
  { model, policy, policyFile }: PolicyBinding,
  cache: ParseCache,
  target: { ability: string; when: string },
): Promise<string> {
  const parsed = await cache.get(policyFile)
  const abilities = parsed ? readPolicyAbilities(parsed.ast, policy) : null
  const declared = abilities && !('unreadable' in abilities)
    ? `${policy} declares ${abilities.declared.join(', ') || 'no ability yet'}`
    : `${policy} could not be read as a policy`
  return (
    `Call await this.authorize('${target.ability}', [${model}, ${camelCase(model)}]) in ${controllerKey} ${target.when} `
    + `(${declared}), or attach authorize()/authorizeResource() middleware to the route. A helper the action `
    + 'calls is not read: if it authorizes there, say so in a // guren-audit-ignore comment above the action.'
  )
}

/**
 * One finding per mutating controller route, and per {@link isEditFormRoute}, keyed `policy:<METHOD> <path>`,
 * once the app has at least one policy; an app with none contributes nothing.
 * Route-level on purpose: the finding carries no `line`, so `config/audit.ts`
 * ignores it by key (a `line` would make every such entry `unsupported`); a
 * `// guren-audit-ignore` comment above the action reports it `ignored` instead.
 * Only the middleware pass rests on the manifest alone; every other verdict
 * read a controller body, so its evidence is `static` (RFC 0026 §5).
 */
export async function auditAuthorization(
  cwd: string,
  routes: readonly AuditedRoute[],
  scan: ControllerMethodScan,
  fromManifest: boolean,
  cache: ParseCache,
  findings: AuditFinding[],
): Promise<void> {
  const bindings = await policyBindings(cwd, cache)
  if (bindings.length === 0) return
  const patternsByFile = new Map<string, Map<PolicyBinding, RegExp[]>>()
  const chainEvidence: CheckEvidence = fromManifest ? 'manifest' : 'static'

  for (const route of routes) {
    const method = route.method.toUpperCase()
    const editForm = isEditFormRoute(route)
    if ((describeMethod(method).safe && !editForm) || !route.controller || GUEST_PATH_PATTERN.test(route.path)) continue
    const target = editForm
      ? { ability: 'update', when: 'before rendering the form', subject: "a record's edit form" }
      : { ability: '<ability>', when: 'before the write', subject: 'a mutating route' }

    const routeLabel = `${method} ${route.path}`
    const push = (status: AuditFinding['status'], message: string, rest: Partial<AuditFinding> = {}) =>
      findings.push({ key: `policy:${routeLabel}`, title: routeLabel, status, message, evidence: 'static', ...rest })

    // Presence, not derivability, as in the agent-route rule: a `mixed` chain
    // still authorizes, whatever ability it resolves.
    if (route.chainAuthorizes) {
      push('pass', 'Authorized by middleware (verified via middleware capabilities).', { evidence: chainEvidence })
      continue
    }

    const { info, className } = controllerMethodFor(scan, route.controller)
    const controllerKey = `${className}.${route.controller.action}`
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
    // An edit form only reads its record; any other action is judged on the models it writes,
    // not on a parent it loads (a comment's post), which its own policy does not govern.
    const named = bindings.filter((binding) => patterns!.get(binding)!.some((pattern) => pattern.test(info.body)))
    const touched = editForm ? named : named.filter((binding) => writesModel(info.body, patterns!.get(binding)!))
    if (touched.length === 0) {
      push(
        'pass',
        named.length === 0
          ? `${controllerKey} names no model the app keeps a policy for; a write through a service or a relationship is not judged.`
          : `${controllerKey} only reads ${describeBindings(named)}; a write through a service, a relationship or a record variable is not judged.`,
      )
      continue
    }
    const readOnlyCheck = editForm ? readOnlyAbility(info.body, info.rawBody) : undefined
    if (
      readOnlyCheck === undefined
      && (consultsAuthorization(info.body) || touched.some((binding) => binding.policyPattern.test(info.body)))
    ) {
      push('pass', `${controllerKey} consults a policy for ${describeBindings(touched)}.`)
      continue
    }

    const message =
      readOnlyCheck !== undefined
        ? `${controllerKey} (${info.filePath}:${info.line}) renders a record's edit form for ${describeBindings(touched)} `
          + `but only checks the '${readOnlyCheck}' ability, which lets anyone who may read the record open its form.`
        : `${controllerKey} (${info.filePath}:${info.line}) references ${describeBindings(touched)} on `
          + `${target.subject}, and neither the middleware chain nor the action body shows an authorization check.`
    const marker = info.leadingComments.find((comment) => comment.includes(AUDIT_IGNORE_MARKER))
    if (marker !== undefined) {
      push('ignored', message, { ignoreReason: marker, filePath: info.filePath })
      continue
    }
    push('warn', message, {
      suggestion: await authorizeSuggestion(controllerKey, touched[0]!, cache, target),
      filePath: info.filePath,
    })
  }
}

/** The one safe route the policy rule judges: GET to an `edit` action, the resource convention for a record's edit form. */
export function isEditFormRoute(route: { method: string; controller?: { action: string } }): boolean {
  return route.method.toUpperCase() === 'GET' && route.controller?.action === 'edit'
}

const EDIT_ABILITIES = new Set(['update', 'edit'])

/**
 * The ability an edit form's action checks when every literal one is a read-only ability
 * (`view`): the form then opens for anyone who may read the record. Undefined when a literal
 * names update/edit, or no ability is a literal (a variable is not judged).
 */
function readOnlyAbility(body: string, rawBody: string): string | undefined {
  const abilities = literalAbilities(body, rawBody)
  if (abilities.length === 0 || abilities.some((ability) => EDIT_ABILITIES.has(ability))) return undefined
  return abilities[0]
}

/** The model class's write methods (`column-consumers.ts` STATIC_ARGUMENTS / BUILDER_ARGUMENTS). */
const MODEL_WRITE_CALL = /\.\s*(?:create|forceCreate|update|forceUpdate|delete|forceDelete|restore)\s*\(/

/**
 * Whether a blanked action body writes the model a reference pattern names: a statement that
 * names it and calls a write method after it, directly (`Post.update(`) or down a builder chain
 * (`Post.where(...)` then `.delete()`, continuation lines joined). A write through a variable
 * holding a record or a builder is not seen.
 */
function writesModel(body: string, references: RegExp[]): boolean {
  for (const statement of body.replace(/\n\s*(?=\.)/g, '').split(/[;\n]/)) {
    for (const reference of references) {
      const at = statement.search(reference)
      if (at !== -1 && MODEL_WRITE_CALL.test(statement.slice(at))) return true
    }
  }
  return false
}

