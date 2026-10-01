/** What every part of the page reads: the payload, the graph built from it, and the reader's choices. */
import type { DocsViewerData, DocsViewerDoc } from '../docs-viewer'
import type { ToggleKind, ViewEdge, ViewNode } from './model'

export const BASE_URL = '/_guren/docs'

/** The simulation runs in a fixed virtual space and the SVG scales it to the viewport. */
export const W = 1200
export const H = 800

export interface SimNode extends ViewNode {
  x: number
  y: number
  vx: number
  vy: number
  r: number
}

export const state = {
  data: { nodes: [], edges: [], docs: [], tests: [], planPages: [], plans: [], unreadablePlanDirs: [] } satisfies DocsViewerData as DocsViewerData,
  docByPath: new Map<string, DocsViewerDoc>(),
  testFiles: new Map<string, string[]>(),
  nodes: [] as SimNode[],
  edges: [] as ViewEdge[],
  byId: new Map<string, SimNode>(),
  neighbors: new Map<string, Set<string>>(),
  nodeEls: [] as Array<{ n: SimNode; g: SVGGElement }>,
  edgeEls: [] as Array<{ e: ViewEdge; line: SVGLineElement }>,
  selected: null as string | null,
  kindEnabled: { doc: true, spec: true, plan: true, entity: true, code: true, test: true } as Record<ToggleKind, boolean>,
  testsGrouped: true,
  searchTerm: '',
}
