import { createHash } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { GurenApplicationGraph } from './application-graph'
import { loadApplicationGraph } from './application-graph-load'
import { joinExposure, type ExposureJoin } from './dependency-exposure'
import { loadDependencyTree } from './dependency-tree-load'
import { collectProjectFiles, IMPORTABLE_EXTENSIONS } from './discovery'
import { cachedFileProbe } from './import-resolution'
import { scanImports } from './import-scan'
import { ParseCache } from './parse-cache'

export interface DependencyExposure extends ExposureJoin {
  schemaVersion: 1
  snapshot: { id: string; graph: string | null; capturedAt: string; consistency: 'stable' | 'changed' }
  lockfile: string | null
  workspace: string
  runtime: []
}

async function fingerprint(paths: readonly string[]): Promise<string> {
  const stats = await Promise.all(paths.map(async (path) => {
    const info = await stat(path).catch(() => null)
    return info ? `${path}:${info.size}:${info.mtimeMs}` : `${path}:absent`
  }))
  return stats.join('\n')
}

/**
 * The exposure of every installed package in the app at `cwd`, read as one
 * snapshot (RFC 0032's rule, applied to the tree and the import scan too): every
 * scanned file is fingerprinted before and after collection, the tree and the file
 * list are read again at the end, and any difference, or one the graph saw, is
 * `changed`.
 */
export async function loadDependencyExposure(options: { cwd: string; introspect?: boolean }): Promise<DependencyExposure> {
  const cwd = resolve(options.cwd)
  const tree = await loadDependencyTree(cwd)
  const files = await collectProjectFiles(cwd, IMPORTABLE_EXTENSIONS)
  const watched = [...(tree.lockfile ? [resolve(cwd, tree.lockfile)] : []), join(cwd, 'package.json'), ...files]
  const before = await fingerprint(watched)

  const imports = await scanImports(cwd, new ParseCache(), files, cachedFileProbe())
  let graph: GurenApplicationGraph | null = null
  try {
    graph = await loadApplicationGraph({ cwd, introspect: options.introspect !== false })
  } catch {
    graph = null
  }

  const after = await fingerprint(watched)
  const treeAfter = await loadDependencyTree(cwd)
  const filesAfter = await collectProjectFiles(cwd, IMPORTABLE_EXTENSIONS)
  const treeKey = (loaded: typeof tree) => JSON.stringify([loaded.lockfile, loaded.coverage.status, loaded.packages.map((instance) => [instance.id, instance.integrity ?? null])])
  const unchanged = before === after && treeKey(tree) === treeKey(treeAfter) && filesAfter.join('\n') === files.join('\n')
  const joined = joinExposure({ tree, imports, graph })
  const content = JSON.stringify({
    graph: graph?.snapshot.id ?? null,
    tree: tree.packages.map((instance) => [instance.id, instance.integrity ?? null]),
    imports: [...imports.files].sort(([a], [b]) => a.localeCompare(b)),
  })

  return {
    schemaVersion: 1,
    snapshot: {
      id: createHash('sha256').update(content).digest('hex'),
      graph: graph?.snapshot.id ?? null,
      capturedAt: new Date().toISOString(),
      consistency: unchanged && graph?.snapshot.consistency !== 'changed' ? 'stable' : 'changed',
    },
    lockfile: tree.lockfile,
    workspace: tree.workspace,
    ...joined,
    runtime: [],
  }
}

export function isCompleteExposure(exposure: DependencyExposure): boolean {
  return exposure.snapshot.consistency === 'stable'
    && (['tree', 'imports', 'placement', 'graph'] as const).every((key) => exposure.coverage[key].status === 'complete')
}
