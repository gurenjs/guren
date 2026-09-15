// The transparent wrappers an oxlint rule must see through, kept in step with
// `unwrapTypeAssertion` in ../ast-walk.ts — the same rule, for the TypeScript
// side. A plugin loads under Node, so it cannot import that module; a case
// missing here is a rule that stops reporting when someone adds a type
// annotation, which is how `as const` / `satisfies` silently disable a gate.
// `ChainExpression` is oxc-only and has no counterpart there.
const WRAPPERS = new Set([
  'ChainExpression',
  'ParenthesizedExpression',
  'TSAsExpression',
  'TSNonNullExpression',
  'TSSatisfiesExpression',
  'TSTypeAssertion',
])

/** The expression under any transparent wrapping, plus the callers' own extras. */
export function unwrap(node, extra) {
  for (;;) {
    if (!node || typeof node !== 'object') return node
    if (extra !== undefined && node.type === extra.type) {
      node = node[extra.key]
      continue
    }
    if (!WRAPPERS.has(node.type)) return node
    if (!node.expression) return node
    node = node.expression
  }
}

/** `process.env.FOO` or `process.env['FOO']`, returning the variable name. */
export function envKey(node) {
  const n = unwrap(node)
  if (n?.type !== 'MemberExpression') return undefined
  const env = unwrap(n.object)
  if (env?.type !== 'MemberExpression') return undefined
  const proc = unwrap(env.object)
  if (proc?.type !== 'Identifier' || proc.name !== 'process') return undefined
  const envProp = env.computed ? undefined : env.property?.name
  if (envProp !== 'env') return undefined
  if (n.computed) return n.property?.type === 'Literal' ? String(n.property.value) : undefined
  return n.property?.name
}

/** `await x` is transparent to what the chain ultimately calls, but only there. */
export const AWAIT = { type: 'AwaitExpression', key: 'argument' }
