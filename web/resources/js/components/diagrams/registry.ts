import { createElement, type ComponentType } from 'react'

import type { InteractiveDiagramName } from '../../../../config/interactive-diagrams.js'
import type { SequenceDiagram } from './StepSequence.js'

export interface InteractiveDiagramProps {
  locale: 'en' | 'ja'
}

type DiagramLoader = () => Promise<ComponentType<InteractiveDiagramProps>>

/** A diagram that is only data for StepSequence. */
const sequence = (load: () => Promise<SequenceDiagram>): DiagramLoader => async () => {
  const [{ StepSequence }, diagram] = await Promise.all([import('./StepSequence.js'), load()])
  return (props) => createElement(StepSequence, { ...props, diagram })
}

/** Dynamic imports, so a page without a diagram never downloads one. */
export const INTERACTIVE_DIAGRAM_LOADERS: Record<InteractiveDiagramName, DiagramLoader> = {
  'plan-lifecycle': () => import('./PlanLifecycle.js').then((module) => module.PlanLifecycle),
  'middleware-order': () => import('./MiddlewareOrder.js').then((module) => module.MiddlewareOrder),
  'csrf-exchange': sequence(() => import('./csrf-exchange.js').then((module) => module.CSRF_EXCHANGE)),
  'queue-lifecycle': sequence(() => import('./queue-lifecycle.js').then((module) => module.QUEUE_LIFECYCLE)),
  'course-loop': sequence(() => import('./course-loop.js').then((module) => module.COURSE_LOOP)),
}
