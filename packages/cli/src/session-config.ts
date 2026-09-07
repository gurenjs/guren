/**
 * The one rule for reading a `SessionConfig` out of an app's source (RFC 0020).
 * `guren check`'s session rules and the deploy-runtime verdicts both ask about
 * the same object, and a second reading is how one reports a backed store while
 * the other skips the table it binds. The anchor is the type, not the file
 * name or the variable: a cache config keys `default`, `stores` and `driver`
 * identically, and `createSessionManager(config)` carries no literal, since the
 * scaffold passes the config by name across modules.
 */
import type { ObjectExpression, Node, Statement } from '@babel/types'
import { DEFAULT_SESSION_STORE_NAME, PER_PROCESS_SESSION_DRIVERS } from '@guren/core'
import { literalString, memberKeyName, objectLiteral, propertyValue, unwrapTypeAssertion, walk, type BabelNode } from './ast-walk'

const SESSION_CONFIG_TYPE = 'SessionConfig'
const GUREN_PACKAGE_PREFIX = '@guren/'

export { DEFAULT_SESSION_STORE_NAME, PER_PROCESS_SESSION_DRIVERS }

export interface SessionConfigRead {
  /** Whether `default:` was written at all; absent means the manager picks {@link DEFAULT_SESSION_STORE_NAME}. */
  declaresDefault: boolean
  /** The store `default:` names, when it is readable. */
  selected: string | undefined
  /** Declared store name → its `driver`, or undefined when the driver is not a literal. */
  stores: Map<string, string | undefined>
}

/** Locals bound to `SessionConfig` from `@guren/*`, type-only imports included. */
function sessionConfigLocals(body: Statement[]): Set<string> {
  const locals = new Set<string>()
  for (const statement of body) {
    if (statement.type !== 'ImportDeclaration') continue
    if (!statement.source.value.startsWith(GUREN_PACKAGE_PREFIX)) continue
    for (const specifier of statement.specifiers) {
      if (specifier.type !== 'ImportSpecifier') continue
      const imported = specifier.imported
      const name = imported.type === 'Identifier' ? imported.name : imported.value
      if (name === SESSION_CONFIG_TYPE) locals.add(specifier.local.name)
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

/** Every `SessionConfig` a file declares, with the line its declarator starts on. */
export function sessionConfigsIn(ast: { program: { body: Statement[] } }): Array<{ config: ObjectExpression; line: number }> {
  const locals = sessionConfigLocals(ast.program.body)
  if (locals.size === 0) return []

  const found: Array<{ config: ObjectExpression; line: number }> = []
  walk(ast.program, (node) => {
    if (node.type !== 'VariableDeclarator') return
    const config = declaredSessionConfig(node, locals)
    if (config) found.push({ config, line: node.loc?.start.line ?? 0 })
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

