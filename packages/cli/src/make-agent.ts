/**
 * `make:agent` (RFC 0017 §3/§4).
 *
 * The class, and everything a fresh app lacks for it: nothing loads a bare
 * class, nothing bounds it, the build cannot find it, and `GurenAgent<Env, …>`
 * names a type no app defines against declarations no app's tsconfig loads.
 * Every patch this cannot make is reported with the text to paste — skipping
 * one silently would leave an app whose agent looks registered and is not.
 */
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

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
import { specifierName } from './route-registrar'
import { resourceName, writeRoot, writeScaffoldFile, type WriterOptions } from './utils'

const AGENT_DIR = 'app/Agents'
const CONFIG_FILE = 'config/agents.ts'
const ENV_FILE = 'config/env.ts'
const TSCONFIG_FILE = 'tsconfig.json'
const ARCH_CANDIDATES = ['guren.arch.ts', 'guren.arch.js', 'guren.arch.mjs'] as const
const PLUGIN_PACKAGE = '@guren/plugin-agents'
/** Declares `Cloudflare.Env` and `DurableObject`, which `GurenAgent`'s own declarations are written against. */
const WORKERS_TYPES_PACKAGE = '@cloudflare/workers-types'

/** How a file this command had to change actually fared. */
export type MakeAgentPatch =
  | { file: string; status: 'created' }
  | { file: string; status: 'patched' }
  /** Nothing to do — the entry or the rule was already there. */
  | { file: string; status: 'skipped'; reason: string }
  /** This could not patch the file (or, for tsconfig.json, there is none). `snippet` is what to paste. */
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

import type { Env } from '@/config/env'

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
 * \`module\` and \`export\` are literal strings: \`guren cloudflare:build\` reads
 * this file as source for the worker's named exports, and \`guren check\` fails
 * a spread, a computed key, or any non-literal value.
 * Scopes are \`tool:<name>\` or \`tools:read\`; set grants (\`tools:*\`, prefixes)
 * are refused, so an unattended agent cannot consent to tools not yet written.
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

/** `Triager` → `TRIAGER`, `TriagerAgent` → `TRIAGER_AGENT` — the same rule `guren cloudflare:build` binds with. */
function durableObjectBindingName(className: string): string {
  return className
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toUpperCase()
}

/**
 * The `config/env.ts` a project gets when it has none: the `Env` every agent
 * class names. Hand-written rather than `wrangler types` output because `tsc`
 * and the Bun test run both read it, and neither can depend on a wrangler
 * invocation having happened first.
 */
function envTemplate(className: string): string {
  return `/**
 * The Worker bindings this app expects. \`Env\` is named by every class under
 * ${AGENT_DIR}/, which \`tsc\` and the Bun test run both read, so it is written by
 * hand rather than generated by \`wrangler types\`.
 */
export interface Env {
  /** The D1 database \`wrangler.jsonc\` binds; \`unknown\` because only the ORM reads it. */
  DB: unknown
  // The Durable Object namespace \`wrangler.jsonc\` binds for each agent class,
  // absent under Bun. Declare one per agent, typed by the RPC surface it exposes:
  // ${durableObjectBindingName(className)}?: { idFromName(name: string): unknown; get(id: unknown): { sweep(): Promise<unknown> } }
}
`
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
    await writeEnvType(cwd, className, options),
    await addWorkersTypes(cwd),
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
  if ((await appDependsOn(cwd, WORKERS_TYPES_PACKAGE)) === false) {
    notes.push(
      `This app does not depend on ${WORKERS_TYPES_PACKAGE}, which GurenAgent's declarations `
      + `need. Run \`bun add -d ${WORKERS_TYPES_PACKAGE}\`.`,
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

/**
 * Write `config/env.ts` when the project has none, and leave an existing one
 * alone as long as it exports the `Env` the class imports — an existing file
 * that does not is reported with the interface to add, since the import the
 * scaffold just wrote would otherwise fail on the next typecheck.
 */
async function writeEnvType(cwd: string, className: string, options: WriterOptions): Promise<MakeAgentPatch> {
  const existing = await readIfExists(cwd, ENV_FILE)

  if (existing === null) {
    await writeScaffoldFile(ENV_FILE, envTemplate(className), options)
    return { file: ENV_FILE, status: 'created' }
  }

  const ast = parseSourceFile(existing, ENV_FILE)
  if (ast !== null && exportsEnv(ast)) {
    return { file: ENV_FILE, status: 'skipped', reason: 'it already exports `Env`' }
  }

  return {
    file: ENV_FILE,
    status: 'refused',
    reason: ast === null
      ? 'the file could not be parsed'
      : `it exports no \`Env\`, which ${AGENT_DIR}/${className}.ts imports from it`,
    snippet: envTemplate(className),
  }
}

/** Whether the module exports a type or interface named `Env`, declared or re-exported. */
function exportsEnv(ast: File): boolean {
  for (const statement of ast.program.body) {
    if (statement.type !== 'ExportNamedDeclaration') continue
    const declaration = statement.declaration
    if (
      (declaration?.type === 'TSInterfaceDeclaration' || declaration?.type === 'TSTypeAliasDeclaration')
      && declaration.id.name === 'Env'
    ) {
      return true
    }
    if (statement.specifiers.some((specifier) =>
      specifier.type === 'ExportSpecifier' && specifierName(specifier.exported) === 'Env')) {
      return true
    }
  }
  return false
}

interface TsconfigShape {
  compilerOptions?: { types?: unknown; [option: string]: unknown }
  [key: string]: unknown
}

/**
 * Add `@cloudflare/workers-types` to `compilerOptions.types`: a text insertion
 * verified by re-parsing, so the rest of the file's formatting survives rather
 * than being round-tripped through `JSON.stringify`. Only strict JSON is
 * patched — comments are a wrangler habit, and get the line to paste instead.
 */
async function addWorkersTypes(cwd: string): Promise<MakeAgentPatch> {
  const snippet = `"types": ["bun-types", "${WORKERS_TYPES_PACKAGE}"]`
  const refuse = (reason: string): MakeAgentPatch => ({ file: TSCONFIG_FILE, status: 'refused', reason, snippet })
  const existing = await readIfExists(cwd, TSCONFIG_FILE)

  if (existing === null) return refuse('there is none at the project root')

  let parsed: unknown
  try {
    parsed = JSON.parse(existing)
  } catch {
    return refuse('it is not strict JSON (comments or trailing commas), which is all this command edits')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return refuse('it is not a JSON object')
  }
  const config = parsed as TsconfigShape

  const types = config.compilerOptions?.types
  if (!Array.isArray(types)) {
    // A new `types` array switches off the automatic @types walk, so it has to
    // name bun-types too — a decision for the reader, not this command.
    return refuse('it has no compilerOptions.types array to extend')
  }
  if (types.includes(WORKERS_TYPES_PACKAGE)) {
    return { file: TSCONFIG_FILE, status: 'skipped', reason: `its \`types\` already names ${WORKERS_TYPES_PACKAGE}` }
  }

  const expected = structuredClone(config)
  expected.compilerOptions!.types = [...types, WORKERS_TYPES_PACKAGE]

  const patched = appendToTypesArray(existing, expected)
  if (patched === null) return refuse('its compilerOptions.types array could not be located in the text')

  await writeFile(resolve(cwd, TSCONFIG_FILE), patched, 'utf8')
  return { file: TSCONFIG_FILE, status: 'patched' }
}

/**
 * The text with the package appended to its `types` array, or `null`. Every
 * `"types": [` in the file is tried, and the first whose result parses to
 * `expected` wins — so a `types` key under `paths` or in a string cannot be
 * patched by mistake.
 */
function appendToTypesArray(text: string, expected: TsconfigShape): string | null {
  for (const match of text.matchAll(/"types"\s*:\s*\[/g)) {
    const open = match.index + match[0].length
    const close = text.indexOf(']', open)
    if (close === -1) continue

    const inner = text.slice(open, close)
    const body = inner.trimEnd()
    const trailing = inner.slice(body.length)
    const entry = `"${WORKERS_TYPES_PACKAGE}"`
    let replaced: string
    if (body.trim() === '') {
      replaced = `${entry}${trailing}`
    } else if (inner.includes('\n')) {
      const indent = /^\s*/.exec(body.slice(body.lastIndexOf('\n') + 1))![0]
      replaced = `${body},\n${indent}${entry}${trailing}`
    } else {
      replaced = `${body}, ${entry}${trailing}`
    }

    const candidate = `${text.slice(0, open)}${replaced}${text.slice(close)}`
    try {
      if (isDeepStrictEqual(JSON.parse(candidate), expected)) return candidate
    } catch {
      continue
    }
  }
  return null
}
