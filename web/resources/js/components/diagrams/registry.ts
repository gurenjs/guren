import type { ComponentType } from 'react'

import type { InteractiveDiagramName } from '../../../../config/interactive-diagrams.js'

export interface InteractiveDiagramProps {
  locale: 'en' | 'ja'
}

type DiagramLoader = () => Promise<ComponentType<InteractiveDiagramProps>>

/** Dynamic imports, so a page without a diagram never downloads one. */
export const INTERACTIVE_DIAGRAM_LOADERS: Record<InteractiveDiagramName, DiagramLoader> = {
  'plan-lifecycle': () => import('./PlanLifecycle.js').then((module) => module.PlanLifecycle),
}
