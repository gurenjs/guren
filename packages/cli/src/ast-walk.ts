import type { Node, ObjectExpression } from '@babel/types'

/**
 * A Babel AST node, typed loosely so a walker can reach children the
 * `@babel/types` unions don't make ergonomic to traverse generically.
 */
export interface BabelNode {
  type: string
  loc?: { start: { line: number } }
  [key: string]: unknown
}

/**
 * Minimal generic AST walker. Recurses into every node-shaped child unless
 * the visitor returns `false` for the current node, which prunes its subtree.
 */
export function walk(value: unknown, visit: (node: BabelNode) => boolean | void): void {
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit)
    return
  }
  if (value === null || typeof value !== 'object') return
  const node = value as BabelNode
  if (typeof node.type !== 'string') return

  if (visit(node) === false) return

  // for...in rather than Object.entries: the latter allocates an entry array
  // per node, which measurably dominates traversal on a large AST.
  for (const key in node) {
    // `*Comments` children carry a `type` of `CommentLine`/`CommentBlock`, so
    // a structural check would walk them as if they were code.
    if (key === 'loc' || key.endsWith('Comments')) continue
    walk(node[key], visit)
  }
}

/**
 * The name a non-computed Identifier or string-literal key spells — the one
 * rule for reading a member's name off an object property or a class member.
 * Computed keys answer `undefined`: `[x]` names whatever `x` holds at runtime,
 * which a static scan cannot know.
 */
export function memberKeyName(member: {
  computed?: boolean
  key: { type: string; name?: string; value?: unknown }
}): string | undefined {
  if (member.computed) return undefined
  if (member.key.type === 'Identifier') return member.key.name
  if (member.key.type === 'StringLiteral' && typeof member.key.value === 'string') return member.key.value
  return undefined
}

/**
 * The expression under any transparent TypeScript wrapping — `x as const`,
 * `x satisfies T`, `x!`, `<T>x`, `(x)`. The one rule for it: a scanner missing
 * a wrapper reports a fully static declaration as unreadable and says nothing.
 * `ParenthesizedExpression` cannot currently occur (`parseSourceFile` does not
 * enable `createParenthesizedExpressions`) and is kept for when it does.
 */
export function unwrapTypeAssertion(node: Node): Node
export function unwrapTypeAssertion(node: BabelNode): BabelNode
export function unwrapTypeAssertion(node: Node | BabelNode): Node | BabelNode {
  let current = node as Node
  if (!current || typeof current !== 'object') return current
  while (
    current.type === 'TSAsExpression' ||
    current.type === 'TSSatisfiesExpression' ||
    current.type === 'TSNonNullExpression' ||
    current.type === 'TSTypeAssertion' ||
    current.type === 'ParenthesizedExpression'
  ) {
    // `literalString` accepts `unknown` and hands it straight here, so a
    // malformed node must answer "not a wrapper" rather than throw.
    if (!current.expression) return current
    current = current.expression
  }
  return current
}

/**
 * The object literal a node denotes, through any transparent wrapping, or `null`
 * when it does not denote one. Every `x.type !== 'ObjectExpression'` test wants
 * this: the bare test reads `{ … } as const` — what the storage and module
 * scaffolds emit — as "not an object". No source-level guard pins the rule,
 * since the bare test is correct wherever the caller already unwrapped.
 */
export function objectLiteral(node: Node | null | undefined): ObjectExpression | null {
  if (!node) return null
  const unwrapped = unwrapTypeAssertion(node)
  return unwrapped.type === 'ObjectExpression' ? unwrapped : null
}

/**
 * The string a node spells statically, or `null` when it does not spell one.
 * A no-substitution template literal counts: ``router.get(`/posts`, …)`` and
 * `router.get('/posts', …)` are the same route. Anything with an interpolation,
 * or a reference to a constant declared elsewhere, is `null` — these scanners
 * miss rather than invent.
 */
export function literalString(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null
  // Unwrapped here rather than at each caller because the miss is silent: a
  // `null` reads as "no value declared", the same answer a genuinely dynamic
  // value gets.
  const node = unwrapTypeAssertion(value as Node) as {
    type?: string
    value?: unknown
    quasis?: Array<{ value?: { cooked?: string } }>
    expressions?: unknown[]
  }

  if (node.type === 'StringLiteral' && typeof node.value === 'string') {
    return node.value
  }

  if (
    node.type === 'TemplateLiteral'
    && node.quasis?.length === 1
    && node.expressions?.length === 0
  ) {
    return node.quasis[0]?.value?.cooked ?? null
  }

  return null
}
