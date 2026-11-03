import { readFile, stat } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { BINARY_LOCKFILE, LOCKFILE, dependencyTree, readBunLock, type DependencyTree } from './dependency-tree'

export interface LoadedDependencyTree extends DependencyTree {
  /** The lockfile read, relative to the app root; null when there is none. */
  lockfile: string | null
  /** The app's key under the lockfile's `workspaces`. */
  workspace: string
}

async function isFile(path: string): Promise<boolean> {
  return (await stat(path).catch(() => null))?.isFile() ?? false
}

/**
 * The tree for the app at `appRoot`, from the nearest `bun.lock` at or above it: an
 * app inside a monorepo is that lockfile's workspace at its relative path. A binary
 * lockfile or none at all is `unavailable`, never an empty tree.
 */
export async function loadDependencyTree(appRoot: string): Promise<LoadedDependencyTree> {
  const root = resolve(appRoot)
  for (let dir = root; ; dir = dirname(dir)) {
    const text = join(dir, LOCKFILE)
    if (await isFile(text)) {
      const workspace = relative(dir, root).split(sep).join('/')
      const reading = readBunLock(await readFile(text, 'utf8'))
      const lockfile = relative(root, text) || LOCKFILE
      if (reading.kind === 'unreadable') {
        return { coverage: { status: 'unavailable', reasons: [{ code: 'unreadable-lockfile', message: reading.reason, file: lockfile }] }, packages: [], lockfile, workspace }
      }
      return { ...dependencyTree(reading.lock, workspace), lockfile, workspace }
    }
    if (await isFile(join(dir, BINARY_LOCKFILE))) {
      const message = `${BINARY_LOCKFILE} is binary; run \`bun install --save-text-lockfile\` to write ${LOCKFILE}.`
      return { coverage: { status: 'unavailable', reasons: [{ code: 'binary-lockfile', message }] }, packages: [], lockfile: null, workspace: '' }
    }
    if (dirname(dir) === dir) break
  }
  const message = `No ${LOCKFILE} at or above the app; run \`bun install\`.`
  return { coverage: { status: 'unavailable', reasons: [{ code: 'no-lockfile', message }] }, packages: [], lockfile: null, workspace: '' }
}
