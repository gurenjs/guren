/**
 * The keys `defineEnv({ … })` declares in `config/env.ts`, read from source, and what each builder chain means
 * (RFC 0040 §5): the plan's `env` section, `plan:status` and `change:lane` judge a key through these, so a key
 * the plan states and the declaration the application holds are compared one way.
 */
import type { CallExpression, Expression, ImportDeclaration, ObjectExpression, ObjectProperty, Program } from '@babel/types'
import { parseExpression } from '@babel/parser'

import { ENV_SCHEMA_FILE } from './app-env'
import { frameworkCallOptions, hidesKeys } from './app-entry'
import { canonicalSyntax, memberKeyName, walk } from './ast-walk'
import { isDefinitelyAbsent, readIfExists } from './discovery'
import { parseSourceFile } from './parse-cache'
import type { PlanEnv } from './plan/schema'
import { envEntrySchemaSource } from './plugin-env'
import type { GurenPluginEnvEntry } from './plugin-manifest'

/** The `defineEnv({ … })` literal of the framework's export, whose every member is a key a reader sees; else undefined. */
export function defineEnvOptions(program: Program): ObjectExpression | undefined {
  const options = frameworkCallOptions(program, 'defineEnv')
  if (!options || hidesKeys(options)) return undefined
  return options.properties.every((property) => property.type === 'ObjectProperty' && memberKeyName(property) !== undefined && memberKeyName(property) !== '__proto__')
    ? options
    : undefined
}

/** Each declared key and its builder chain, in source order. */
export function declaredEnvKeys(options: ObjectExpression): Array<{ key: string; value: ObjectProperty['value'] }> {
  return (options.properties as ObjectProperty[]).map((property) => ({ key: memberKeyName(property)!, value: property.value }))
}

const FRAMEWORK = new Set(['@guren/core', '@guren/server'])

/** The framework imports' value specifiers binding `Env` to the framework's `Env`, which a builder chain is read as. */
export function frameworkEnvImports(program: Program): Array<{ declaration: ImportDeclaration; index: number }> {
  return program.body.flatMap((node) => {
    if (node.type !== 'ImportDeclaration' || node.importKind === 'type' || !FRAMEWORK.has(node.source.value)) return []
    return node.specifiers.flatMap((specifier, index) =>
      specifier.type === 'ImportSpecifier' && specifier.importKind !== 'type' && specifier.local.name === 'Env'
        && (specifier.imported.type === 'Identifier' ? specifier.imported.name : specifier.imported.value) === 'Env' ? [{ declaration: node, index }] : [])
  })
}

/** The calls that set a key's presence. */
const PRESENCE = new Set(['optional', 'default', 'requiredInProduction'])
/** Calls that set a flag whatever their place in the chain. */
const FLAGS = new Set(['secret', 'allowEmpty'])

/**
 * What a builder chain declares, as one comparable string: the `Env` builder with its arguments, its one presence
 * call, and the flags. `.describe()` with a string is prose and left out. `undefined` for a chain holding anything
 * else (a second presence call, an argument to a flag), which no plan states.
 */
export function envBuilderSignature(value: ObjectProperty['value']): string | undefined {
  const calls: Array<{ name: string; args: CallExpression['arguments'] }> = []
  let node: ObjectProperty['value'] = value
  while (node.type === 'CallExpression' && node.callee.type === 'MemberExpression' && !node.callee.computed && node.callee.property.type === 'Identifier') {
    calls.unshift({ name: node.callee.property.name, args: node.arguments })
    node = node.callee.object
  }
  const root = calls.shift()
  if (node.type !== 'Identifier' || node.name !== 'Env' || root === undefined) return undefined
  // `optional()` keeps an earlier `default()`'s value as the schema's default, so two presence calls are not the last one.
  const presences = calls.filter((call) => PRESENCE.has(call.name))
  if (presences.length > 1) return undefined
  const flags = new Set<string>()
  for (const call of calls) {
    if (PRESENCE.has(call.name)) continue
    // Every argument the comparison leaves out is code the import runs, so a flag takes none and prose one string.
    if (FLAGS.has(call.name) && call.args.length === 0) flags.add(call.name)
    else if (!(call.name === 'describe' && call.args.length === 1 && call.args[0]!.type === 'StringLiteral')) return undefined
  }
  const presence = presences[0] ? `${presences[0].name}${canonicalSyntax(presences[0].args)}` : 'required'
  return JSON.stringify([root.name, canonicalSyntax(root.args), presence, [...flags].sort()])
}

/** The signature of the declaration `guren plugin` would write for `entry`, the one rule for what a planned key means. */
export function plannedEnvSignature(entry: GurenPluginEnvEntry): string | undefined {
  try {
    return envBuilderSignature(parseExpression(envEntrySchemaSource(entry)) as Expression)
  } catch {
    return undefined
  }
}

/** A planned key as the manifest entry `guren plugin` would declare it from. */
export function planEnvEntry(env: PlanEnv): GurenPluginEnvEntry {
  return {
    key: env.key,
    ...(env.type === undefined ? {} : { type: env.type }),
    ...(env.choices === undefined ? {} : { choices: env.choices }),
    ...(env.default === undefined ? {} : { default: env.default }),
    ...(env.required === undefined ? {} : { required: env.required }),
    ...(env.secret === undefined ? {} : { secret: env.secret }),
    ...(env.description === undefined ? {} : { comment: env.description }),
  }
}

/** One key `config/env.ts` declares: its builder chain as written, and what that chain means. */
export interface EnvDeclaration {
  key: string
  /** The chain as written, or a placeholder for one calling `.secret()`, whose default is never echoed. */
  source: string
  signature: string | undefined
  /** Why the chain has no signature although it reads as one: the `Env` it calls is not the framework's. */
  unverified?: string
}

/** Whether a chain calls `.secret()` anywhere, read apart from its signature so an unread chain is redacted too. */
function callsSecret(value: ObjectProperty['value']): boolean {
  let found = false
  walk(value, (node) => {
    const member = node as unknown as { computed?: boolean; property?: { name?: string } }
    if (node.type === 'MemberExpression' && !member.computed && member.property?.name === 'secret') found = true
  })
  return found
}

/**
 * The keys the project root's `config/env.ts` declares, read from source and never imported. No file is no keys;
 * a file whose `defineEnv()` literal cannot be read whole, or a path that is there and will not read, is the reason,
 * which no check passes or fails.
 */
export async function readEnvDeclarations(root: string): Promise<EnvDeclaration[] | { unreadable: string }> {
  const content = await readIfExists(root, ENV_SCHEMA_FILE).catch((error: unknown) => ({ failed: error instanceof Error ? error.message : String(error) }))
  if (content === null) {
    // A dangling symlink reads as absent; it is a schema not generated yet, not one declaring nothing.
    return (await isDefinitelyAbsent(root, ENV_SCHEMA_FILE)) ? [] : { unreadable: `${ENV_SCHEMA_FILE} is there and would not open` }
  }
  if (typeof content !== 'string') return { unreadable: `${ENV_SCHEMA_FILE} would not open (${content.failed})` }
  const ast = parseSourceFile(content, ENV_SCHEMA_FILE)
  const options = ast ? defineEnvOptions(ast.program) : undefined
  if (!ast || !options) return { unreadable: `${ENV_SCHEMA_FILE} does not call the framework's defineEnv() once, with a literal whose every key is spelled` }
  const framework = frameworkEnvImports(ast.program).length > 0
  return declaredEnvKeys(options).map(({ key, value }) => {
    const written = value.start !== null && value.start !== undefined && value.end !== null && value.end !== undefined ? content.slice(value.start, value.end) : key
    const signature = envBuilderSignature(value)
    return {
      key,
      source: callsSecret(value) ? 'a secret declaration (not shown)' : written,
      signature: framework ? signature : undefined,
      ...(!framework && signature !== undefined ? { unverified: `${ENV_SCHEMA_FILE} does not import Env from the framework, so Env.<type>() is not read as its builder` } : {}),
    }
  })
}
