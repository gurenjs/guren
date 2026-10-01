import { graphId, type GraphNode } from './application-graph'
import type { ParseCache } from './parse-cache'
import { readValidatorExports, type PlanAppValidatorExports } from './plan/app-detail'
import { isUnreadable, type PlanAppUnreadable } from './plan/unreadable'

/** Shared static schema identities; detail consumers retain the same exports for later imports. */
export async function readValidatorGraph(
  cwd: string,
  cache: ParseCache,
  onUnreadFile?: (file: string) => void,
): Promise<{ nodes: GraphNode[]; exports: PlanAppValidatorExports[] | PlanAppUnreadable }> {
  const exports = await readValidatorExports(cwd, cache, false, onUnreadFile)
  return {
    exports,
    nodes: isUnreadable(exports) ? [] : exports.flatMap(({ file, module, names }) => names.map((name) => ({
      id: graphId('validator', file, name), kind: 'validator' as const,
      label: name, module, file, evidence: [{ kind: 'static' as const, source: 'source', file }],
    }))),
  }
}
