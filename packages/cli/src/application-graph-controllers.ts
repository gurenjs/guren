import { graphId, type GraphNode } from './application-graph'
import { parseControllerMethods, type ControllerMethodScan } from './controller-methods'
import { moduleNameFromRelPath } from './discovery'
import type { ParseCache } from './parse-cache'

/**
 * The controller identities shared by graph and Plan readers. The caller owns
 * source freshness through its ParseCache; this reader performs no app imports.
 * Keep the scan alongside the nodes: Plan detail and Impact need action bodies,
 * which the structural graph deliberately does not serialize.
 */
export interface ControllerGraphReading {
  nodes: GraphNode[]
  scan: ControllerMethodScan
}

export async function readControllerGraph(cwd: string, cache: ParseCache): Promise<ControllerGraphReading> {
  const scan = await parseControllerMethods(cwd, cache)
  return {
    scan,
    nodes: scan.declarations.map((declaration) => ({
      id: graphId('controller', declaration.file, declaration.className),
      kind: 'controller', label: declaration.className,
      module: moduleNameFromRelPath(declaration.file), file: declaration.file,
      evidence: [{ kind: 'static', source: 'source', file: declaration.file }],
    })),
  }
}
