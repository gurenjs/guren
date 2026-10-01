import { graphId, type GraphNode } from './application-graph'
import { moduleNameFromRelPath, toPosixRelative } from './discovery'
import { discoverInertiaPageFiles } from './inertia-pages'
import type { ParseCache } from './parse-cache'

export interface PageGraphReading {
  nodes: GraphNode[]
  /** Plan existence checks name component files even when their source does not parse. */
  candidates: GraphNode[]
  unparsedFiles: string[]
}

export async function readPageGraph(cwd: string, cache: ParseCache): Promise<PageGraphReading> {
  const reading: PageGraphReading = { nodes: [], candidates: [], unparsedFiles: [] }
  for (const { id, filePath } of await discoverInertiaPageFiles(cwd)) {
    const file = toPosixRelative(cwd, filePath)
    const node: GraphNode = {
      id: graphId('page', file, id), kind: 'page', label: id,
      module: moduleNameFromRelPath(file), file, evidence: [{ kind: 'static', source: 'source', file }],
    }
    reading.candidates.push(node)
    if (await cache.get(filePath)) reading.nodes.push(node)
    else reading.unparsedFiles.push(file)
  }
  return reading
}
