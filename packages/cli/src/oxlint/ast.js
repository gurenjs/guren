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

/** `await x` is transparent to what the chain ultimately calls, but only there. */
export const AWAIT = { type: 'AwaitExpression', key: 'argument' }
