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
 * Comment arrays hang off nodes and hold entries that are node-shaped enough
 * to fool a structural check — they carry a `type` of `CommentLine`/
 * `CommentBlock`. Walking them wastes traversal on text that is by definition
 * not code, so they're skipped by key.
 */
const SKIPPED_KEYS = new Set(['loc', 'leadingComments', 'trailingComments', 'innerComments'])

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
    if (SKIPPED_KEYS.has(key)) continue
    walk(node[key], visit)
  }
}

/** Line a node starts on, defaulting to 1 when location info is absent. */
export function lineOf(node: BabelNode): number {
  return node.loc?.start.line ?? 1
}
