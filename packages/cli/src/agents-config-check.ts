/**
 * The agent registry check (RFC 0017 §3): `config/agents.ts` read as *source*,
 * because that is how `guren cloudflare:build` reads it.
 *
 * The build recovers a module path and export name statically, so a spread or a
 * `module` built from a variable leaves it unreadable while staying valid
 * TypeScript — a deploy whose agents are silently absent. The grammar half is
 * `@guren/server`'s `classifyRegistrationScope`. Content-activated.
 */
import { resolve } from 'node:path'
import type { ObjectExpression } from '@babel/types'
import { classifyRegistrationScope, deriveAgentTools, expandToolScopes } from '@guren/core'
import type { RouteDefinition, ScopedTool } from '@guren/core'

import {
  defaultExportConfigProperty,
  literalString,
  memberKeyName,
  objectLiteral,
  unwrapTypeAssertion,
} from './ast-walk'
import { check, type CheckResult } from './check-result'
import { fileExists } from './discovery'
import type { ParseCache } from './parse-cache'

/** The one place the registry lives. `guren cloudflare:build` reads this path. */
export const AGENTS_CONFIG_FILE = 'config/agents.ts'

export interface AgentsConfigCheckOptions {
  cwd: string
  cache: ParseCache
  /**
   * The app's registered route definitions, when `runCheck` already loaded
   * them. Absent, the tool-existence half is skipped rather than loading the
   * graph a second time — an unknown tool is a warning, and a warning is not
   * worth importing an application for.
   */
  definitions?: RouteDefinition[]
}

/**
 * What one registration says, as the source spells it. Every field is either a
 * literal the build can read or `undefined`, which is itself the finding.
 */
interface ParsedRegistration {
  agent: string
  module?: string
  export?: string
  /** `undefined` when `scopes` is absent or not a literal array of literal strings. */
  scopes?: string[]
  /** Why this entry cannot be read statically, when it cannot. */
  problem?: string
}

export interface AgentsConfigExpansion {
  agent: string
  /** The tools `scopes` expands to against the loaded route graph. */
  tools: string[]
}

export interface AgentsConfigCheckResult {
  checks: CheckResult[]
  /**
   * What each agent's scopes expand to, for `--json` consumers (RFC 0017 Open
   * Question 2). A check-time computation on purpose: pinning it into a
   * generated artifact would make an agent's authority a file that can be
   * stale, and the whole value of the expansion is that it is recomputed from
   * the route graph on every run.
   */
  expansions?: AgentsConfigExpansion[]
}

/**
 * No registry at all. `expansions` is *absent* rather than empty, so a JSON
 * consumer can tell "this app hosts no agents" from "it hosts agents whose
 * scopes expand to nothing".
 */
const EMPTY: AgentsConfigCheckResult = { checks: [] }

export async function checkAgentsConfig(
  options: AgentsConfigCheckOptions,
): Promise<AgentsConfigCheckResult> {
  const { cwd, cache } = options
  const filePath = resolve(cwd, AGENTS_CONFIG_FILE)
  if (!(await fileExists(cwd, AGENTS_CONFIG_FILE))) return EMPTY

  const parsed = await cache.read(filePath)
  if (parsed.status !== 'parsed') {
    return {
      checks: [
        check(
          'agents-config-parse',
          'Agent registry',
          'fail',
          `${AGENTS_CONFIG_FILE} could not be parsed, so neither this check nor `
          + '`guren cloudflare:build` can read which classes are agents.',
          'Fix the syntax error.',
          AGENTS_CONFIG_FILE,
        ),
      ],
      expansions: [],
    }
  }

  const agents = objectLiteral(
    defaultExportConfigProperty(parsed.ast, 'defineAgentsConfig', 'agents'),
  )
  if (agents === null) {
    return {
      checks: [
        check(
          'agents-config-grammar',
          'Agent registry',
          'fail',
          `${AGENTS_CONFIG_FILE} does not export a default \`defineAgentsConfig({ agents: { … } })\` `
          + 'with a literal `agents` object. `guren cloudflare:build` reads this file as source to '
          + 'generate the worker\'s named exports, so a re-exported config, a spread, or a computed '
          + 'value leaves it with no agents to export — and the deploy succeeds with none of them '
          + 'mounted.',
          'Write the registry inline:\n'
          + "  export default defineAgentsConfig({ agents: { triager: { module: 'app/Agents/Triager.ts', "
          + "export: 'Triager', scopes: ['tools:read'] } } })",
          AGENTS_CONFIG_FILE,
        ),
      ],
      expansions: [],
    }
  }

  const checks: CheckResult[] = []

  if (agents.properties.some((property) => property.type === 'SpreadElement')) {
    checks.push(
      check(
        'agents-config-spread',
        'Agent registry',
        'fail',
        `The \`agents\` object in ${AGENTS_CONFIG_FILE} contains a spread. `
        + '`guren cloudflare:build` reads this file statically and cannot follow one, so whatever '
        + 'the spread contributes is absent from the generated worker while the config reads as '
        + 'though it were registered.',
        'Write every registration as a literal key in this object.',
        AGENTS_CONFIG_FILE,
      ),
    )
  }

  const registrations = readRegistrations(agents)

  // Two entries under one key: the later one wins at runtime and the earlier is
  // simply gone, so a registration a human wrote and can still read has no
  // effect. Object literals allow it silently.
  const seenAgents = new Set<string>()
  for (const registration of registrations) {
    if (seenAgents.has(registration.agent)) {
      checks.push(
        check(
          `agents-config-duplicate-agent:${registration.agent}`,
          `Agent registry: ${registration.agent}`,
          'fail',
          `"${registration.agent}" is registered twice in the same object. The later entry wins `
          + 'and the earlier one is silently discarded, so one of the two registrations you can '
          + 'read here does nothing.',
          'Delete the duplicate, or give the second agent its own name.',
          AGENTS_CONFIG_FILE,
        ),
      )
    }
    seenAgents.add(registration.agent)
  }

  const tools = options.definitions ? scopedTools(options.definitions) : undefined
  const toolNames = tools ? new Set(tools.map((tool) => tool.name)) : undefined
  const expansions: AgentsConfigExpansion[] = []

  // Keyed by export name, because that is what the runtime registry is keyed by
  // and what the build appends as a named export. The same rule
  // `validateAgentsConfig` enforces at boot, checked here so it fails in review
  // rather than on the first wake of whichever agent lost.
  const seenExports = new Map<string, string>()

  for (const registration of registrations) {
    const { agent } = registration

    if (registration.problem) {
      checks.push(
        check(
          `agents-config-static:${agent}`,
          `Agent registry: ${agent}`,
          'fail',
          registration.problem,
          'Every value in a registration is a literal string; the Cloudflare build reads them '
          + 'from the source, not from a running module.',
          AGENTS_CONFIG_FILE,
        ),
      )
      continue
    }

    checks.push(...(await moduleFindings(cwd, cache, registration)))

    if (registration.export !== undefined) {
      const claimedBy = seenExports.get(registration.export)
      if (claimedBy !== undefined) {
        checks.push(
          check(
            `agents-config-duplicate-export:${agent}`,
            `Agent registry: ${agent}`,
            'fail',
            `The export "${registration.export}" is already registered as "${claimedBy}". One class `
            + 'is one agent: the runtime registry and the generated worker are both keyed on the '
            + 'export name, so a second claim on it makes one of the two registrations unreachable.',
            'Give each agent its own class, or delete the duplicate registration.',
            AGENTS_CONFIG_FILE,
          ),
        )
      } else {
        seenExports.set(registration.export, agent)
      }
    }

    if (registration.scopes === undefined) {
      checks.push(
        check(
          `agents-config-scopes:${agent}`,
          `Agent registry: ${agent}`,
          'fail',
          `The registration for "${agent}" has no literal \`scopes\` array. An agent that may call `
          + 'nothing is written as `scopes: []`; an omitted or computed one leaves what it may '
          + 'reach unreadable.',
          "Add `scopes: ['tools:read']` (or the tool names it needs).",
          AGENTS_CONFIG_FILE,
        ),
      )
      continue
    }

    for (const scope of registration.scopes) {
      const verdict = classifyRegistrationScope(scope)
      if (!verdict.allowed) {
        checks.push(
          check(
            `agents-config-scope:${agent}:${scope}`,
            `Agent registry: ${agent}`,
            'fail',
            verdict.message,
            'The registration grammar is `tool:<name>` for one tool by exact name, or '
            + '`tools:read` for every read-only tool.',
            AGENTS_CONFIG_FILE,
          ),
        )
        continue
      }

      if (verdict.scope.kind === 'tool' && toolNames && !toolNames.has(verdict.scope.name)) {
        checks.push(
          check(
            `agents-config-unknown-tool:${agent}:${verdict.scope.name}`,
            `Agent registry: ${agent}`,
            'warn',
            `"${agent}" is scoped to the tool "${verdict.scope.name}", which no route in this `
            + 'application declares. The scope grants nothing — the gate is fail-closed — so this '
            + 'is a typo or a route that was renamed, not a hole.',
            'Run `guren tool:list` to see the tools this application exposes.',
            AGENTS_CONFIG_FILE,
          ),
        )
      }
    }

    if (tools) {
      // RFC 0017 Open Question 2, answered as a check-time computation: what
      // `tools:read` actually grants, recomputed from the route graph every
      // run rather than pinned into an artifact that can go stale.
      expansions.push({ agent, tools: expandToolScopes(registration.scopes, tools) })
    }
  }

  if (checks.length === 0) {
    checks.push(
      check(
        'agents-config',
        'Agent registry',
        'pass',
        `${AGENTS_CONFIG_FILE} registers ${registrations.length} agent(s) in the static grammar the `
        + 'Cloudflare build reads, with registrable scopes.',
        undefined,
        AGENTS_CONFIG_FILE,
      ),
    )
  }

  return { checks, expansions }
}

async function moduleFindings(
  cwd: string,
  cache: ParseCache,
  registration: ParsedRegistration,
): Promise<CheckResult[]> {
  const { agent, module: modulePath, export: exportName } = registration
  if (!modulePath || !exportName) {
    return [
      check(
        `agents-config-identity:${agent}`,
        `Agent registry: ${agent}`,
        'fail',
        `The registration for "${agent}" is missing a literal \`module\` or \`export\`. The `
        + 'Cloudflare build needs both to append `export { Class } from \'…\'` to the generated '
        + 'worker; without them the class is never exported and the Durable Object binding has '
        + 'nothing to point at.',
        "Add `module: 'app/Agents/Triager.ts'` and `export: 'Triager'`.",
        AGENTS_CONFIG_FILE,
      ),
    ]
  }

  if (!(await fileExists(cwd, modulePath))) {
    return [
      check(
        `agents-config-module:${agent}`,
        `Agent registry: ${agent}`,
        'fail',
        `"${agent}" names the module "${modulePath}", which does not exist.`,
        'Point `module` at the file holding the agent class, project-relative.',
        AGENTS_CONFIG_FILE,
      ),
    ]
  }

  const exported = await moduleExports(cache, resolve(cwd, modulePath), exportName)
  if (exported === 'class' || exported === 'unreadable') return []

  return [
    check(
      `agents-config-export:${agent}`,
      `Agent registry: ${agent}`,
      'fail',
      exported === 'absent'
        ? `"${modulePath}" does not export "${exportName}". The generated worker would re-export a `
          + 'name that does not exist, which fails the deploy build rather than this one.'
        : `"${modulePath}" exports "${exportName}", but not as a class declaration of that name. `
          + 'An agent is found at runtime by `this.constructor.name`, so a renamed export '
          + '(`export { Actual as ' + exportName + ' }`), a type-only export, or a non-class value '
          + `registers under a name the runtime never sees — the Durable Object boots and then `
          + 'cannot find its own registration.',
      `Export the class directly: \`export class ${exportName} extends GurenAgent\`.`,
      AGENTS_CONFIG_FILE,
    ),
  ]
}

/** A node read only for its kind and the name it declares, past Babel's union. */
type NamedNode = { type?: string; id?: { name?: string } }

/**
 * Whether the module at `absolutePath` exports `exportName`.
 *
 * Read, never imported: an agent module imports `agents`, which throws on
 * evaluation anywhere but workerd — importing it would fail this check on
 * every machine, for every correct config.
 */
async function moduleExports(
  cache: ParseCache,
  absolutePath: string,
  exportName: string,
): Promise<'class' | 'wrong-kind' | 'absent' | 'unreadable'> {
  const parsed = await cache.read(absolutePath)
  if (parsed.status !== 'parsed') {
    // Unreadable or unparseable source is not evidence of a missing export,
    // and whatever compiles the file will report the real problem.
    return 'unreadable'
  }

  // Class *declarations* in the module, by their own name — which is the name
  // `this.constructor.name` will report, and therefore the only name the
  // runtime registry can be keyed on.
  const classNames = new Set<string>()
  for (const statement of parsed.ast.program.body) {
    const declaration =
      statement.type === 'ExportNamedDeclaration' || statement.type === 'ExportDefaultDeclaration'
        ? (statement.declaration as NamedNode | null)
        : (statement as NamedNode)
    if (declaration?.type === 'ClassDeclaration' && declaration.id?.name) {
      classNames.add(declaration.id.name)
    }
  }

  let seen = false
  for (const statement of parsed.ast.program.body) {
    if (statement.type !== 'ExportNamedDeclaration') continue

    // `export type { Triager }` exports nothing at runtime.
    const typeOnlyStatement = (statement as { exportKind?: string }).exportKind === 'type'

    const declaration = statement.declaration as
      | (NamedNode & { declarations?: Array<{ id?: { name?: string } }> })
      | null
    if (declaration && !typeOnlyStatement) {
      // `export class X`, `export function X`, `export const X = …` — the last
      // carries its name on the declarator rather than the declaration, and a
      // value export of the right name is still the wrong *kind* here.
      const names = declaration.declarations
        ? declaration.declarations.map((entry) => entry.id?.name)
        : [declaration.id?.name]
      if (names.includes(exportName)) {
        seen = true
        if (declaration.type === 'ClassDeclaration') return 'class'
      }
    }

    for (const specifier of statement.specifiers) {
      const exported = specifier.exported as { name?: string; value?: string }
      if ((exported.name ?? exported.value) !== exportName) continue
      if (typeOnlyStatement || (specifier as { exportKind?: string }).exportKind === 'type') {
        seen = true
        continue
      }
      seen = true
      // `export { Actual as Triager }` binds the *local* name's value, whose
      // class is named `Actual` — so `this.constructor.name` answers "Actual"
      // and the registry lookup for "Triager" misses.
      const local = (specifier as { local?: { name?: string } }).local?.name
      if (local === exportName && classNames.has(exportName)) return 'class'
    }
  }

  return seen ? 'wrong-kind' : 'absent'
}

function scopedTools(definitions: RouteDefinition[]): ScopedTool[] {
  const { tools } = deriveAgentTools(definitions)
  return tools.map((tool) => ({ name: tool.toolName, readOnly: tool.annotations.readOnlyHint }))
}

function readRegistrations(agents: ObjectExpression): ParsedRegistration[] {
  const registrations: ParsedRegistration[] = []

  for (const property of agents.properties) {
    if (property.type !== 'ObjectProperty') continue

    if (property.computed) {
      registrations.push({
        agent: '(computed key)',
        problem:
          'A registration key is computed. The Cloudflare build reads these keys from the source '
          + 'and cannot evaluate one.',
      })
      continue
    }

    const agent = memberKeyName(property)
    if (agent === undefined) continue

    const body = objectLiteral(property.value as never)
    if (!body) {
      registrations.push({
        agent,
        problem: `The registration for "${agent}" is not an object literal, so nothing in it can be read statically.`,
      })
      continue
    }

    const registration: ParsedRegistration = { agent }

    if (body.properties.some((member) => member.type === 'SpreadElement')) {
      registration.problem =
        `The registration for "${agent}" contains a spread. The Cloudflare build reads it `
        + 'statically and cannot follow one.'
      registrations.push(registration)
      continue
    }

    for (const member of body.properties) {
      if (member.type !== 'ObjectProperty' || member.computed) continue
      const memberKey = member.key as { type?: string; name?: string }
      if (memberKey.type !== 'Identifier') continue

      if (memberKey.name === 'module' || memberKey.name === 'export') {
        const value = literalString(member.value)
        if (value === null) {
          registration.problem =
            `The \`${memberKey.name}\` of "${agent}" is not a literal string. The Cloudflare build `
            + 'reads it from the source and cannot evaluate an expression.'
        } else if (memberKey.name === 'module') {
          registration.module = value
        } else {
          registration.export = value
        }
      }

      if (memberKey.name === 'scopes') {
        // An unreadable `scopes` stays `undefined` and is reported by the
        // `scopes` finding above rather than as a static-grammar problem: "not
        // a literal array" and "absent" have the same fix and the same
        // fail-closed consequence.
        registration.scopes = readScopes(member.value)
      }
    }

    registrations.push(registration)
  }

  return registrations
}

/**
 * The literal strings of a literal array, or `undefined` for anything else.
 *
 * Unwrapped first: `scopes: [...] as const` is as static as the bare array, and
 * reading it as "not an array" fails a correct registry.
 */
function readScopes(value: unknown): string[] | undefined {
  const node = unwrapTypeAssertion(value as never) as
    | { type?: string; elements?: unknown[] }
    | undefined
  if (node?.type !== 'ArrayExpression') return undefined

  const scopes: string[] = []
  for (const element of node.elements ?? []) {
    const literal = literalString(element)
    if (literal === null) return undefined
    scopes.push(literal)
  }
  return scopes
}
