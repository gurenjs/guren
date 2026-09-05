/**
 * `make:agent` (RFC 0017 §3/§4).
 *
 * Three files, and the two beyond the class are the point: an agent class alone
 * is inert — nothing loads it, nothing bounds it, the build cannot find it.
 *
 * Everything beyond the new class is patched through the AST, and every patch
 * it cannot make is reported with the text to paste. Silently skipping one
 * would leave an app whose agent looks registered and is not.
 */
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import type { File, Node, ObjectExpression } from '@babel/types'

import {
  defaultExportConfigProperty,
  literalString,
  memberKeyName,
  objectLiteral,
  unwrapTypeAssertion,
} from './ast-walk'
import { appDependsOn, readIfExists } from './discovery'
import { parseSourceFile } from './parse-cache'
import { resourceName, writeRoot, writeScaffoldFile, type WriterOptions } from './utils'

const AGENT_DIR = 'app/Agents'
const CONFIG_FILE = 'config/agents.ts'
const ARCH_CANDIDATES = ['guren.arch.ts', 'guren.arch.js', 'guren.arch.mjs'] as const
const PLUGIN_PACKAGE = '@guren/plugin-agents'

/** How a file this command had to change actually fared. */
export type MakeAgentPatch =
  | { file: string; status: 'created' }
  | { file: string; status: 'patched' }
  /** Nothing to do — the entry or the rule was already there. */
  | { file: string; status: 'skipped'; reason: string }
  /** The file exists but this could not patch it. `snippet` is what to paste. */
  | { file: string; status: 'refused'; reason: string; snippet: string }

export interface MakeAgentResult {
  /** The agent class file. */
  file: string
  patches: MakeAgentPatch[]
  /** Things the user has to do that this command deliberately did not. */
  notes: string[]
}

/**
 * The class an agent starts as: a state shape, a cron schedule, one tool call.
 *
 * A string builder rather than a `templates/scaffold/` file, as `make:policy`
 * is: the class name appears in four places and the state interface name
 * derives from it, so a static file would hold nothing.
 */
export function buildAgentTemplate(className: string): string {
  const stateType = `${className}State`

  return `import { GurenAgent } from '${PLUGIN_PACKAGE}/agent'

interface ${stateType} {
  lastRunAt: string | null
}

/**
 * An agent is durable identity and durable state — not a durable JavaScript
 * stack. An instance is evicted after inactivity, so anything that must
 * survive is checkpointed into \`this.setState\` or \`this.sql\` and resumed by
 * a schedule. Locals, timers and in-flight fetches do not survive.
 */
export class ${className} extends GurenAgent<Env, ${stateType}> {
  initialState: ${stateType} = { lastRunAt: null }

  async onStart(): Promise<void> {
    // Cron schedules are idempotent, so re-registering on every wake does not
    // accumulate rows.
    await this.schedule('0 7 * * *', 'sweep')
  }

  async sweep(): Promise<void> {
    // Every call goes through the application's own gates: scopes, policies,
    // approvals, audit. Widen what this agent may reach by adding scopes in
    // config/agents.ts, never by importing a model.
    const result = await this.tools.call('posts.index', {})

    // Waiting on a human. Nothing ran; come back to it on a later wake.
    if (result.pending) return

    if (result.ok) {
      this.setState({ lastRunAt: new Date().toISOString() })
    }

    // Delay form, in seconds.
    await this.schedule(3600, 'sweep')
  }
}
`
}

/** The `config/agents.ts` a project gets when it has none. */
function configTemplate(agentName: string, className: string): string {
  return `import { defineAgentsConfig } from '${PLUGIN_PACKAGE}'

/**
 * The agent registry. \`module\` and \`export\` are literal strings because
 * \`guren cloudflare:build\` reads this file as source to append the worker's
 * named exports — a spread, a computed key, or a non-literal value makes it
 * unreadable, and \`guren check\` fails over exactly those forms.
 *
 * Scopes use the registration grammar: \`tool:<name>\` for one tool by exact
 * name, or \`tools:read\` for every read-only tool. Set grants
 * (\`tools:*\`, \`tools:<prefix>.*\`) are refused — an unattended agent must not
 * acquire consent to tools that do not exist yet.
 */
export default defineAgentsConfig({
  agents: {
${registrationEntry(agentName, className)}
  },
})
`
}

function registrationEntry(agentName: string, className: string): string {
  return `    ${agentName}: {
      module: '${AGENT_DIR}/${className}.ts',
      export: '${className}',
      scopes: ['tools:read'],
    },`
}

/**
 * One list, read twice: it is what the rule this command writes forbids, and
 * what an existing `app/Agents/**` rule must forbid for this command to leave
 * it alone. RFC 0017 §4 leans on `guren.arch.ts` for enforcement, so the
 * question is not "does a rule exist" but "does it cover what an agent must not
 * reach" — a `warn` rule blocking only `db/**` reads as coverage and is not.
 */
const REQUIRED_DISALLOW = ['app/Models/**', 'db/**']
const REQUIRED_PACKAGES = ['@guren/orm', '@guren/plugin-agents/runtime']

const ARCH_RULE_MESSAGE =
  'Agents act through the tool surface, never through application internals '
  + '(RFC 0017 §4). Widen what this agent may reach by adding scopes in config/agents.ts.'

function archRuleSource(): string {
  const quoted = (entries: readonly string[]): string =>
    entries.map((entry) => `'${entry}'`).join(', ')

  return `    {
      from: '${AGENT_DIR}/**',
      disallow: [${quoted(REQUIRED_DISALLOW)}],
      disallowPackages: [${quoted(REQUIRED_PACKAGES)}],
      message:
        '${ARCH_RULE_MESSAGE}',
    },`
}

/** The `guren.arch.ts` a project gets when it has none. */
function archTemplate(): string {
  return `import { defineArchRules } from '@guren/cli/arch'

export default defineArchRules({
  rules: [
${archRuleSource()}
  ],
})
`
}

export interface MakeAgentOptions extends WriterOptions {}

/**
 * Scaffold an agent, register it, and pin the boundary it may not cross.
 *
 * @throws When `--module` is passed. Agents are project-root citizens in this
 *   part: the registry is one file the Cloudflare build reads, and a
 *   per-module registry is a design question, not a path join.
 */
export async function makeAgent(name: string, options: MakeAgentOptions = {}): Promise<MakeAgentResult> {
  if (options.root) {
    throw new Error(
      'make:agent does not support --module. Agents are registered in one project-root '
      + 'config/agents.ts, which `guren cloudflare:build` reads to generate the worker\'s named '
      + 'exports; a per-module registry is not designed yet. Scaffold the agent at the project root.',
    )
  }

  const { className } = resourceName(name)
  const agentName = className.charAt(0).toLowerCase() + className.slice(1)
  const cwd = writeRoot(options)

  const file = await writeScaffoldFile(
    `${AGENT_DIR}/${className}.ts`,
    buildAgentTemplate(className),
    options,
  )

  const patches: MakeAgentPatch[] = [
    await registerAgent(cwd, agentName, className, options),
    await extendArchRules(cwd, options),
  ]

  const notes: string[] = []
  // `=== false` on purpose: a manifest this cannot read is a reason to stay
  // quiet, not to tell the user to install something they may already have.
  if ((await appDependsOn(cwd, PLUGIN_PACKAGE)) === false) {
    notes.push(
      `This app does not depend on ${PLUGIN_PACKAGE}. Run \`guren plugin ${PLUGIN_PACKAGE}\` to `
      + 'install it and register the provider.',
    )
  }

  return { file, patches, notes }
}

/**
 * Add the registration to `config/agents.ts`, creating the file when absent.
 *
 * The insertion point is parsed, not matched: a text search for `agents: {`
 * would patch one inside a comment or a string as readily as the real one.
 */
async function registerAgent(
  cwd: string,
  agentName: string,
  className: string,
  options: WriterOptions,
): Promise<MakeAgentPatch> {
  const snippet = registrationEntry(agentName, className)
  const existing = await readIfExists(cwd, CONFIG_FILE)

  if (existing === null) {
    await writeScaffoldFile(CONFIG_FILE, configTemplate(agentName, className), options)
    return { file: CONFIG_FILE, status: 'created' }
  }

  const ast = parseSourceFile(existing, CONFIG_FILE)
  if (ast === null) {
    return {
      file: CONFIG_FILE,
      status: 'refused',
      reason: 'the file could not be parsed',
      snippet,
    }
  }

  const agents = findAgentsObject(ast)
  if (agents === null) {
    return {
      file: CONFIG_FILE,
      status: 'refused',
      reason:
        'it does not export a default defineAgentsConfig({ agents: { … } }) with a literal '
        + '`agents` object. The grammar is static because `guren cloudflare:build` reads this '
        + 'file as source',
      snippet,
    }
  }

  if (agents.keys.has(agentName)) {
    return {
      file: CONFIG_FILE,
      status: 'skipped',
      reason: `\`${agentName}\` is already registered`,
    }
  }

  const patched = `${existing.slice(0, agents.insertAt)}\n${snippet}${existing.slice(agents.insertAt)}`
  await writeFile(resolve(cwd, CONFIG_FILE), patched, 'utf8')
  return { file: CONFIG_FILE, status: 'patched' }
}

interface AgentsObject {
  /** Offset just past the object's opening brace. */
  insertAt: number
  /** The agent names already registered. */
  keys: Set<string>
}

/**
 * The `agents` object of the default `defineAgentsConfig(...)` export, or
 * `null` when the file does not follow the static grammar.
 *
 * The same walk `guren check` uses: what the build cannot read, this must not
 * patch. A spread inside the object is still patched — the check reports it.
 */
function findAgentsObject(ast: File): AgentsObject | null {
  const agents = objectLiteral(defaultExportConfigProperty(ast, 'defineAgentsConfig', 'agents'))
  // `start` is typed nullable by `@babel/types`, and an offset is the whole
  // point here: without one there is nothing to insert at.
  if (!agents || typeof agents.start !== 'number') return null

  const keys = new Set<string>()
  for (const entry of agents.properties) {
    if (entry.type !== 'ObjectProperty') continue
    const key = memberKeyName(entry)
    if (key !== undefined) keys.add(key)
  }

  return { insertAt: agents.start + 1, keys }
}

/**
 * Add the agent boundary rule to `guren.arch.ts`, creating the file when
 * absent and leaving it alone when a rule already covers `app/Agents/**`.
 */
async function extendArchRules(cwd: string, options: WriterOptions): Promise<MakeAgentPatch> {
  const snippet = archRuleSource()

  for (const candidate of ARCH_CANDIDATES) {
    const existing = await readIfExists(cwd, candidate)
    if (existing === null) continue

    const ast = parseSourceFile(existing, candidate)
    const rules = ast === null ? null : findRulesArray(ast)
    if (rules === null) {
      return {
        file: candidate,
        status: 'refused',
        reason: 'it does not export a default defineArchRules({ rules: [ … ] }) with a literal array',
        snippet,
      }
    }

    if (rules.coversAgents) {
      return {
        file: candidate,
        status: 'skipped',
        reason: `a rule for \`${AGENT_DIR}/**\` already forbids everything this one would`,
      }
    }

    const patched = `${existing.slice(0, rules.insertAt)}\n${snippet}${existing.slice(rules.insertAt)}`
    await writeFile(resolve(cwd, candidate), patched, 'utf8')
    return { file: candidate, status: 'patched' }
  }

  await writeScaffoldFile(ARCH_CANDIDATES[0], archTemplate(), options)
  return { file: ARCH_CANDIDATES[0], status: 'created' }
}

/**
 * Whether one declared rule already enforces the agent boundary.
 *
 * Stricter than "names `app/Agents/**`": accepting a rule that stops nothing
 * would leave the app with a boundary it believes is enforced. Severity
 * defaults to `'fail'` unwritten, as `defineArchRules` documents.
 */
function ruleCoversAgents(rule: ObjectExpression | null): boolean {
  if (!rule) return false

  const value = (name: string): Node | undefined => {
    for (const property of rule.properties) {
      if (property.type !== 'ObjectProperty' || property.computed) continue
      if (memberKeyName(property) === name) return property.value as Node
    }
    return undefined
  }

  if (literalString(value('from')) !== `${AGENT_DIR}/**`) return false

  const severity = value('severity')
  if (severity !== undefined && literalString(severity) !== 'fail') return false

  const covered = (node: Node | undefined): Set<string> => {
    const single = literalString(node)
    if (single !== null) return new Set([single])
    const unwrapped = node ? (unwrapTypeAssertion(node) as { type?: string; elements?: unknown[] }) : undefined
    if (unwrapped?.type !== 'ArrayExpression') return new Set()
    const names = new Set<string>()
    for (const element of unwrapped.elements ?? []) {
      const literal = literalString(element)
      if (literal !== null) names.add(literal)
    }
    return names
  }

  const disallow = covered(value('disallow'))
  const packages = covered(value('disallowPackages'))
  return (
    REQUIRED_DISALLOW.every((entry) => disallow.has(entry))
    && REQUIRED_PACKAGES.every((entry) => packages.has(entry))
  )
}

interface RulesArray {
  insertAt: number
  /** Whether some rule already declares `from: 'app/Agents/**'`. */
  coversAgents: boolean
}

function findRulesArray(ast: File): RulesArray | null {
  const value = defaultExportConfigProperty(ast, 'defineArchRules', 'rules')
  if (!value) return null

  // `rules: [ … ] as const` is a real spelling in a typed arch config, and a
  // bare shape test reads it as "no rules array" — so this scaffolder would
  // refuse to patch a file it understands perfectly well.
  const rules = unwrapTypeAssertion(value) as {
    type?: string
    start?: number
    elements?: unknown[]
  }
  if (rules.type !== 'ArrayExpression' || typeof rules.start !== 'number') return null

  const coversAgents = (rules.elements ?? []).some((element) =>
    ruleCoversAgents(objectLiteral(element as never)))

  return { insertAt: rules.start + 1, coversAgents }
}
