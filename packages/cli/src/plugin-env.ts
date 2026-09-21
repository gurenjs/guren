/**
 * A plugin manifest's env entry as a `defineEnv({ ... })` declaration (RFC 0027 §1):
 * the builders a manifest may name, what makes an entry invalid, and the source
 * `guren plugin` writes. One module, because validation and generation must agree
 * on what each type accepts, and the manifest is untrusted input becoming source.
 */
import type { Env } from '@guren/server'
import type { GurenPluginEnvEntry } from './plugin-manifest'
import { escapeSingleQuoted } from './utils'

/** The JSON type each builder's `default` takes. `custom` is absent: its validator is not data. */
const DEFAULT_KINDS = {
  string: 'string',
  url: 'string',
  number: 'number',
  port: 'number',
  boolean: 'boolean',
  enum: 'string',
} as const satisfies Partial<Record<keyof typeof Env, 'string' | 'number' | 'boolean'>>

export type GurenPluginEnvType = keyof typeof DEFAULT_KINDS

/** The text an env file assigns, as the `default` `type`'s builder takes; unchanged when it does not convert. */
export function envDefaultFromText(text: string, type: GurenPluginEnvType = 'string'): string | number | boolean {
  switch (DEFAULT_KINDS[type]) {
    case 'number': return text.trim() === '' ? text : Number(text)
    case 'boolean': return text === 'true' ? true : text === 'false' ? false : text
    default: return text
  }
}

export function envDeclarationProblem(entry: GurenPluginEnvEntry): string | undefined {
  const type = entry.type ?? 'string'
  if (!Object.hasOwn(DEFAULT_KINDS, type)) {
    return `type must be one of ${Object.keys(DEFAULT_KINDS).join(', ')}.`
  }
  for (const flag of ['required', 'secret'] as const) {
    if (entry[flag] !== undefined && typeof entry[flag] !== 'boolean') return `${flag} must be true or false.`
  }

  const { choices } = entry
  if (type === 'enum') {
    if (!Array.isArray(choices) || choices.length === 0 || !choices.every((choice) => typeof choice === 'string')) {
      return 'type "enum" needs a non-empty choices array of strings.'
    }
  } else if (choices !== undefined) {
    return 'choices applies to type "enum" only.'
  }

  const fallback = entry.default
  if (fallback === undefined) return undefined
  const expected = DEFAULT_KINDS[type]
  if (typeof fallback !== expected || (typeof fallback === 'number' && !Number.isFinite(fallback))) {
    return `default must be a ${expected} for type "${type}".`
  }
  // `.default()` stores its value unchecked, so the builder's own rule is applied here.
  if (type === 'port' && !(Number.isInteger(fallback) && (fallback as number) >= 1 && (fallback as number) <= 65535)) {
    return 'default must be a port (an integer from 1 to 65535).'
  }
  if (type === 'enum' && !choices?.includes(fallback as string)) {
    return 'default must be one of its choices.'
  }
  return undefined
}

const literal = (text: string): string => `'${escapeSingleQuoted(text)}'`

/** The `defineEnv({ ... })` value for an entry `envDeclarationProblem` accepted. */
export function envEntrySchemaSource(entry: GurenPluginEnvEntry): string {
  const type = entry.type ?? 'string'
  const chain = [type === 'enum' ? `Env.enum([${(entry.choices ?? []).map(literal).join(', ')}])` : `Env.${type}()`]
  if (entry.default !== undefined) {
    chain.push(`.default(${typeof entry.default === 'string' ? literal(entry.default) : String(entry.default)})`)
  } else if (entry.required !== true) {
    chain.push('.optional()')
  }
  if (entry.secret === true) chain.push('.secret()')
  if (entry.comment) chain.push(`.describe(${literal(entry.comment)})`)
  return chain.join('')
}
