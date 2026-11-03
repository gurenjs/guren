/**
 * The names a `<!-- interactive: name -->` marker in docs Markdown may use.
 * Each one needs a loader in `resources/js/components/diagrams/registry.ts`,
 * which its type enforces.
 */
export const INTERACTIVE_DIAGRAMS = ['plan-lifecycle', 'middleware-order'] as const

export type InteractiveDiagramName = (typeof INTERACTIVE_DIAGRAMS)[number]

export function isInteractiveDiagramName(name: string): name is InteractiveDiagramName {
  return (INTERACTIVE_DIAGRAMS as readonly string[]).includes(name)
}
