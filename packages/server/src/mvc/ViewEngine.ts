import { inertia } from './inertia/InertiaEngine'

export type ViewRenderer = (template: string, props: Record<string, unknown>) => Response

/**
 * Registry for view renderers. Engines are typically registered via service
 * providers so applications can opt into or replace implementations.
 */
export class ViewEngine {
  private static readonly engines = new Map<string, ViewRenderer>()

  static register(name: string, renderer: ViewRenderer): void {
    this.engines.set(name, renderer)
  }

  static has(name: string): boolean {
    return this.engines.has(name)
  }

  static render(name: string, template: string, props: Record<string, unknown>): Response {
    const engine = this.engines.get(name)

    if (!engine) {
      throw new Error(`View engine \"${name}\" has not been registered.`)
    }

    return engine(template, props)
  }
}
