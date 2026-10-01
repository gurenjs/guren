import { graphId, type GraphNode } from './application-graph'
import { discoverModelClasses, firstClassDeclaration } from './model-parser'
import { toPosixRelative } from './discovery'
import type { ParseCache } from './parse-cache'

export interface ModelGraphReading {
  nodes: GraphNode[]
  /** RFC 0030 names only the first class in a file, even when it is anonymous. */
  primaryNodes: GraphNode[]
  unsupportedFiles: string[]
  unreadableFiles: string[]
}

/** File-scoped identities; the caller's cache owns freshness and no app code is imported. */
export async function readModelGraph(cwd: string, cache: ParseCache): Promise<ModelGraphReading> {
  const reading: ModelGraphReading = { nodes: [], primaryNodes: [], unsupportedFiles: [], unreadableFiles: [] }
  const files = new Map<string, GraphNode[]>()
  for (const model of await discoverModelClasses(cwd, cache)) {
    const file = toPosixRelative(cwd, model.filePath)
    let nodes = files.get(model.filePath)
    if (!nodes) { nodes = []; files.set(model.filePath, nodes) }
    if (!model.classDecl) { reading.unsupportedFiles.push(file); continue }
    const node: GraphNode = {
      id: graphId('model', file, model.className), kind: 'model', label: model.className,
      module: model.module, file, evidence: [{ kind: 'static', source: 'source', file }],
    }
    nodes.push(node)
    reading.nodes.push(node)
  }
  for (const [file, nodes] of files) {
    const outcome = await cache.read(file)
    if (outcome.status === 'unreadable') { reading.unreadableFiles.push(toPosixRelative(cwd, file)); continue }
    if (outcome.status !== 'parsed') continue
    const name = firstClassDeclaration(outcome.ast.program.body)?.id?.name
    const primary = nodes.find((node) => node.label === name)
    if (primary) reading.primaryNodes.push(primary)
  }
  return reading
}
