import { graphId } from '../application-graph'
import type { ControllerGraphReading } from '../application-graph-controllers'
import type { ControllerMethodScan } from '../controller-methods'
import { formatTruncatedList } from '../discovery'
import type { PlanAppNames } from './app-state'
import type { PlanAppUnreadable } from './unreadable'

/**
 * RFC 0032 M3: project shared graph identities into RFC 0030's existing names.
 * The compatibility view retains the scanner's class/action collision order;
 * changing that rule would change approved context hashes and needs its own
 * migration. The graph itself retains every file-scoped declaration.
 */
export function planControllerSections(reading: ControllerGraphReading): {
  classes: PlanAppNames
  actions: PlanAppNames
  scan: ControllerMethodScan | PlanAppUnreadable
} {
  const { scan } = reading
  const skipped = [...scan.unreadableFiles, ...scan.unparsedFiles]
  if (skipped.length > 0) {
    const unreadable = { unreadable: `${skipped.length} controller file(s) did not parse: ${formatTruncatedList(skipped)}` }
    return { classes: unreadable, actions: unreadable, scan: unreadable }
  }
  const nodes = new Map(reading.nodes.map((node) => [node.id, node]))
  const named = (name: string, file: string) => {
    const node = nodes.get(graphId('controller', file.split('\\').join('/'), name))
    if (!node) throw new Error('A controller scan has no corresponding graph identity.')
    return { name: node.label, module: node.module }
  }
  // A fallback class label or computed action name may contain dots. Resolve
  // each action by its captured method object rather than splitting its display key.
  const scopesByMethod = new Map(scan.declarations.flatMap((declaration) =>
    [...declaration.methods.values()].map((method) => [method, named(declaration.className, declaration.file).module] as const),
  ))
  return {
    classes: [...scan.classFiles].map(([name, file]) => named(name, file)),
    actions: [...scan.methods].map(([key, info]) => ({ name: key, module: scopesByMethod.get(info)! })),
    scan,
  }
}
