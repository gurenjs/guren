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
