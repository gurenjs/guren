import { realpath } from 'node:fs/promises'
import { sep } from 'node:path'

/**
 * Is `candidate` a path strictly below `root`, judged lexically?
 *
 * The trailing separator is what keeps out a sibling directory whose name
 * merely extends the root's (`…/inertia` vs `…/inertia-secrets`), and what
 * rejects an absolute `candidate` — which `resolve()` returns verbatim when a
 * doubled slash in the request path left the relative part rooted.
 *
 * Cheap, but not sufficient on its own: `resolve()` collapses `..` without
 * following symlinks. Use {@link isRealPathWithin} before reading the file.
 */
export function isPathWithin(root: string, candidate: string): boolean {
  return candidate.startsWith(root.endsWith(sep) ? root : root + sep)
}

/**
 * Is `candidate` a path strictly below `root` once both are canonicalized?
 *
 * Every reader downstream of these checks (`Bun.file().text()`,
 * `.arrayBuffer()`, `new Response(file)`) follows symlinks, so a lexical check
 * alone accepts `<root>/link/secret` where `link` points out of the tree.
 * *Both* sides are canonicalized: a root reached through a symlink itself is
 * routine (workspace and pnpm layouts, macOS `/var` → `/private/var`), and
 * canonicalizing only the candidate would 404 every asset such an app serves.
 *
 * Call this on a path already known to exist — a path that does not exist
 * cannot be read, and `realpath` rejects it, so either way this fails closed.
 */
export async function isRealPathWithin(root: string, candidate: string): Promise<boolean> {
  if (!isPathWithin(root, candidate)) {
    return false
  }

  const [realRoot, realCandidate] = await Promise.all([canonicalize(root), canonicalize(candidate)])

  if (!realRoot || !realCandidate) {
    return false
  }

  return isPathWithin(realRoot, realCandidate)
}

async function canonicalize(path: string): Promise<string | undefined> {
  try {
    return await realpath(path)
  } catch {
    return undefined
  }
}
