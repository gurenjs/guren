/**
 * The one rule for reading a `SessionConfig` out of an app's source (RFC 0020),
 * annotated or returned by a `defineSessionConfig()` resolver (RFC 0027 §2).
 * `guren check`'s session rules and the deploy-runtime verdicts both ask about
 * the same object, and a second reading is how one reports a backed store while
 * the other skips the table it binds. The anchor is the type, not the file
 * name or the variable: a cache config keys `default`, `stores` and `driver`
 * identically, and `createSessionManager(config)` carries no literal, since the
 * scaffold passes the config by name across modules.
 */
import type { ObjectExpression, Node, Statement } from '@babel/types'
import { DEFAULT_SESSION_STORE_NAME } from '@guren/core'
import { literalString, memberKeyName, objectLiteral, propertyValue, unwrapTypeAssertion, walk, type BabelNode } from './ast-walk'

const SESSION_CONFIG_TYPE = 'SessionConfig'
const SESSION_DEFINITION_HELPER = 'defineSessionConfig'
const GUREN_PACKAGE_PREFIX = '@guren/'

export { DEFAULT_SESSION_STORE_NAME }

export interface SessionConfigRead {
  /** Whether `default:` was written at all; absent means the manager picks {@link DEFAULT_SESSION_STORE_NAME}. */
  declaresDefault: boolean
  /** The store `default:` names, when it is readable. */
  selected: string | undefined
  /** Declared store name → its `driver`, or undefined when the driver is not a literal. */
  stores: Map<string, string | undefined>
}

/** Locals bound to `imported` from `@guren/*`, type-only imports included. */
function gurenLocals(body: Statement[], imported: string): Set<string> {
  const locals = new Set<string>()
  for (const statement of body) {
    if (statement.type !== 'ImportDeclaration') continue
    if (!statement.source.value.startsWith(GUREN_PACKAGE_PREFIX)) continue
    for (const specifier of statement.specifiers) {
      if (specifier.type !== 'ImportSpecifier') continue
      const name = specifier.imported.type === 'Identifier' ? specifier.imported.name : specifier.imported.value
      if (name === imported) locals.add(specifier.local.name)
    }
  }
  return locals
}

function typeReferenceName(node: BabelNode | undefined): string | undefined {
  if (node?.type !== 'TSTypeReference') return undefined
  const typeName = node.typeName as BabelNode
  return typeName?.type === 'Identifier' ? (typeName.name as string) : undefined
}

/**
 * The object a declarator declares as a `SessionConfig`, by annotation
 * (`const c: SessionConfig = {…}`) or by assertion (`{…} satisfies SessionConfig`).
 * Both spellings are idiomatic, and reading only the first is how a rule goes
 * quiet on a config it should judge.
 */
function declaredSessionConfig(node: BabelNode, locals: Set<string>): ObjectExpression | undefined {
  const init = node.init as Node | undefined
  if (!init) return undefined

  const id = node.id as BabelNode
  const annotation = (id?.typeAnnotation as BabelNode | undefined)?.typeAnnotation as BabelNode | undefined
  const asserted = (init as BabelNode).type === 'TSAsExpression' || (init as BabelNode).type === 'TSSatisfiesExpression'
    ? ((init as BabelNode).typeAnnotation as BabelNode | undefined)
    : undefined

  for (const candidate of [annotation, asserted]) {
    const name = typeReferenceName(candidate)
    if (name && locals.has(name)) return objectLiteral(unwrapTypeAssertion(init)) ?? undefined
  }
  return undefined
}

/**
 * The object a `defineSessionConfig(...)` call's resolver returns (RFC 0027 §2),
 * from an arrow's expression body or a function's `return`. Its `default` reads
 * a declared key (`env.SESSION_DRIVER`), which reads as unresolved rather than
 * as a store.
 */
function definedSessionConfig(node: BabelNode, helpers: Set<string>): ObjectExpression | undefined {
  const callee = node.callee as BabelNode
  if (callee?.type !== 'Identifier' || !helpers.has(callee.name as string)) return undefined
  const resolver = (node.arguments as BabelNode[] | undefined)?.[0]
  if (resolver?.type !== 'ArrowFunctionExpression' && resolver?.type !== 'FunctionExpression') return undefined

  const body = resolver.body as BabelNode
  if (body.type !== 'BlockStatement') return objectLiteral(unwrapTypeAssertion(body as Node)) ?? undefined

  let returned: ObjectExpression | undefined
  walk(body as Node, (inner) => {
    if (inner.type === 'ArrowFunctionExpression' || inner.type === 'FunctionExpression' || inner.type === 'FunctionDeclaration') return false
    if (inner.type === 'ReturnStatement' && !returned) {
      returned = objectLiteral(unwrapTypeAssertion(inner.argument as Node)) ?? undefined
    }
  })
  return returned
}

export interface SessionConfigSite {
  config: ObjectExpression
  line: number
  /** `declared` for a `SessionConfig`-typed object, `defined` for a `defineSessionConfig()` resolver's. */
  form: 'declared' | 'defined'
}

/** Every session config a file declares or defines, with the line it starts on. */
export function sessionConfigsIn(ast: { program: { body: Statement[] } }): SessionConfigSite[] {
  const locals = gurenLocals(ast.program.body, SESSION_CONFIG_TYPE)
  const helpers = gurenLocals(ast.program.body, SESSION_DEFINITION_HELPER)
  if (locals.size === 0 && helpers.size === 0) return []

  const found: SessionConfigSite[] = []
  walk(ast.program, (node) => {
    const line = node.loc?.start.line ?? 0
    const declared = node.type === 'VariableDeclarator' ? declaredSessionConfig(node, locals) : undefined
    if (declared) found.push({ config: declared, line, form: 'declared' })
    const defined = node.type === 'CallExpression' ? definedSessionConfig(node, helpers) : undefined
    if (defined) found.push({ config: defined, line, form: 'defined' })
  })
  return found
}

/**
 * `default` is read through `??`/`||` so the scaffold's
 * `process.env.SESSION_DRIVER ?? 'database'` resolves to its fallback; an
 * environment that overrides it at runtime is beyond a static read.
 */
function selectedStore(config: ObjectExpression): { declaresDefault: boolean; selected: string | undefined } {
  const value = propertyValue(config, 'default')
  if (value === undefined) return { declaresDefault: false, selected: undefined }
  return { declaresDefault: true, selected: fallbackString(value) }
}

function fallbackString(node: Node): string | undefined {
  const unwrapped = unwrapTypeAssertion(node) as BabelNode
  if (unwrapped?.type === 'LogicalExpression' && (unwrapped.operator === '??' || unwrapped.operator === '||')) {
    return fallbackString(unwrapped.right as Node)
  }
  return literalString(unwrapped) ?? undefined
}

export function readSessionConfig(config: ObjectExpression): SessionConfigRead {
  const stores = new Map<string, string | undefined>()
  const declared = objectLiteral(propertyValue(config, 'stores'))
  for (const entry of (declared?.properties ?? []) as unknown as BabelNode[]) {
    if (entry.type !== 'ObjectProperty') continue
    const name = memberKeyName({ computed: Boolean(entry.computed), key: entry.key as never })
    if (!name) continue
    const store = objectLiteral(entry.value as Node)
    stores.set(name, store ? fallbackString(propertyValue(store, 'driver') as Node) : undefined)
  }

  return { ...selectedStore(config), stores }
}

/** The `table` identifier a store binds, for the `database` driver's schema check. */
export function storeTableIdentifier(store: ObjectExpression): string | undefined {
  const table = propertyValue(store, 'table') as BabelNode | undefined
  return table?.type === 'Identifier' ? (table.name as string) : undefined
}

