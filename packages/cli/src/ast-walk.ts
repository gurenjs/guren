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
    // `leadingComments`/`trailingComments`/`innerComments` hold entries
    // node-shaped enough to fool a structural check — they carry a `type` of
    // `CommentLine`/`CommentBlock` — so walking them spends traversal on text
    // that is by definition not code.
    if (key === 'loc' || key.endsWith('Comments')) continue
    walk(node[key], visit)
  }
}

/**
 * The name a non-computed Identifier or string-literal key spells — the one
 * rule for reading a member's name off an object property or a class member,
 * shared by every scanner that asks (model, schema, deploy-runtime, console
 * command surface). Computed keys answer `undefined`: `[x]` names whatever
 * `x` holds at runtime, which a static scan cannot know, so treating
 * `[signature]` as the literal name `signature` would be a guess.
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
 * `x satisfies T`, `x!`, `<T>x`, `(x)`. These change nothing about what the
 * runtime receives, so every scanner judging a node's *shape* unwraps first.
 *
 * The one rule for it, because the cost of a second copy is silence rather
 * than a wrong answer: these scanners report "cannot read" and "nothing to
 * flag" as the same empty result, so a scanner missing a wrapper reports a
 * fully static declaration as unreadable and says nothing. Three spellings
 * of this loop had already drifted apart across the package before it was
 * hoisted here.
 *
 * `ParenthesizedExpression` cannot currently occur — `parseSourceFile` does
 * not enable `createParenthesizedExpressions` — but it is kept so that
 * turning that option on stays a one-line change rather than a silent
 * regression in every scanner at once.
 */
export function unwrapTypeAssertion(node: Node): Node {
  let current = node
  while (
    current.type === 'TSAsExpression' ||
    current.type === 'TSSatisfiesExpression' ||
    current.type === 'TSNonNullExpression' ||
    current.type === 'TSTypeAssertion' ||
    current.type === 'ParenthesizedExpression'
  ) {
    current = current.expression
  }
  return current
}

/**
 * The object literal a node denotes, through any transparent wrapping, or
 * `null` when it does not denote one.
 *
 * Every `x.type !== 'ObjectExpression'` test in a scanner wants this: the
 * bare test reads `{ … } as const` — the shape the storage and module
 * scaffolds actually emit — as "not an object", and the scan then skips the
 * one config it most needed to read.
 */
export function objectLiteral(node: Node | null | undefined): ObjectExpression | null {
  if (!node) return null
  const unwrapped = unwrapTypeAssertion(node)
  return unwrapped.type === 'ObjectExpression' ? unwrapped : null
}

/**
 * The string a node spells statically, or `null` when it does not spell one.
 *
 * A no-substitution template literal counts, because ``router.get(`/posts`,
 * ...)`` and `router.get('/posts', ...)` are the same route — a scanner that
 * knows only `StringLiteral` reads the first as no route at all. Anything with
 * an interpolation, or a reference to a constant declared elsewhere, is `null`:
 * these scanners miss rather than invent.
 */
export function literalString(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null
  const node = value as {
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
