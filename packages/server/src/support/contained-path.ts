import { realpath } from 'node:fs/promises'
import { sep } from 'node:path'

/**
 * Lexical containment. The trailing separator keeps out a sibling whose name
 * merely extends the root's (`…/inertia` vs `…/inertia-secrets`) and rejects an
 * absolute `candidate`, which `resolve()` returns verbatim. Not sufficient
 * alone: `resolve()` collapses `..` without following symlinks, so use
 * {@link isRealPathWithin} before reading the file.
 */
export function isPathWithin(root: string, candidate: string): boolean {
  return candidate.startsWith(root.endsWith(sep) ? root : root + sep)
}

/**
 * Containment once both sides are canonicalized. Every reader downstream
 * (`Bun.file().text()`, `new Response(file)`) follows symlinks, so a lexical
 * check alone accepts `<root>/link/secret`. *Both* sides, because a root
 * reached through a symlink is routine (macOS `/var` → `/private/var`) and
 * doing only the candidate would 404 every asset such an app serves.
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
