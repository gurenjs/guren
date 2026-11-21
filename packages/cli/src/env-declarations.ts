/**
 * The keys `defineEnv({ … })` declares in `config/env.ts`, read from source, and what each builder chain means
 * (RFC 0040 §5): the plan's `env` section, `plan:status` and `change:lane` judge a key through these, so a key
 * the plan states and the declaration the application holds are compared one way.
 */
import type { Expression, ObjectExpression, ObjectProperty, Program } from '@babel/types'
import { parseExpression } from '@babel/parser'

import { ENV_SCHEMA_FILE } from './app-env'
import { frameworkCallOptions, hidesKeys } from './app-entry'
import { canonicalSyntax, memberKeyName } from './ast-walk'
import { readIfExists } from './discovery'
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

/** The calls that set a key's presence: the last one wins, so their order is part of what a chain means. */
const PRESENCE = new Set(['optional', 'default', 'requiredInProduction'])
/** Calls that set a flag whatever their place in the chain. */
const FLAGS = new Set(['secret', 'allowEmpty'])

/**
 * What a builder chain declares, as one comparable string: the `Env` builder with its arguments, the presence the
 * last presence call leaves, and the flags. `.describe()` is prose and left out. `undefined` for a chain holding
 * anything else, which no plan states.
 */
export function envBuilderSignature(value: ObjectProperty['value']): string | undefined {
  const calls: Array<{ name: string; args: string }> = []
  let node: ObjectProperty['value'] = value
  while (node.type === 'CallExpression' && node.callee.type === 'MemberExpression' && !node.callee.computed && node.callee.property.type === 'Identifier') {
    calls.unshift({ name: node.callee.property.name, args: canonicalSyntax(node.arguments) })
    node = node.callee.object
  }
  const root = calls.shift()
  if (node.type !== 'Identifier' || node.name !== 'Env' || root === undefined) return undefined
  let presence = 'required'
  const flags = new Set<string>()
  for (const call of calls) {
    if (PRESENCE.has(call.name)) presence = `${call.name}${call.args}`
    else if (FLAGS.has(call.name)) flags.add(call.name)
    else if (call.name !== 'describe') return undefined
  }
  return JSON.stringify([root.name, root.args, presence, [...flags].sort()])
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
  source: string
  signature: string | undefined
}

/**
 * The keys the project root's `config/env.ts` declares, read from source and never imported. No file is no keys;
 * a file whose `defineEnv()` literal cannot be read whole is the reason, which no check passes or fails.
 */
export async function readEnvDeclarations(root: string): Promise<EnvDeclaration[] | { unreadable: string }> {
  const content = await readIfExists(root, ENV_SCHEMA_FILE).catch((error: unknown) => ({ failed: error instanceof Error ? error.message : String(error) }))
  if (content === null) return []
  if (typeof content !== 'string') return { unreadable: `${ENV_SCHEMA_FILE} would not open (${content.failed})` }
  const ast = parseSourceFile(content, ENV_SCHEMA_FILE)
  const options = ast ? defineEnvOptions(ast.program) : undefined
  if (!options) return { unreadable: `${ENV_SCHEMA_FILE} does not call the framework's defineEnv() once, with a literal whose every key is spelled` }
  return declaredEnvKeys(options).map(({ key, value }) => ({
    key,
    source: value.start !== null && value.start !== undefined && value.end !== null && value.end !== undefined ? content.slice(value.start, value.end) : key,
    signature: envBuilderSignature(value),
  }))
}
