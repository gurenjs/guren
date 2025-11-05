import type React from 'react'

export type PageModule = { default: React.ComponentType<any> }
export type PageLoader = () => Promise<PageModule>
export type ResolveComponent = (name: string) => Promise<PageModule>

export interface PagesResolverOptions {
  pages?: Record<string, () => Promise<unknown>>
  resolveComponentPath?: (name: string) => string
}

export function createPagesResolver(options: PagesResolverOptions): ResolveComponent {
  if (!options.pages) {
    throw new Error('Inertia page resolution requires either a `resolve` function or a `pages` map created via import.meta.glob().')
  }

  const pages = options.pages as Record<string, PageLoader>
  const resolveComponentPath = options.resolveComponentPath ?? defaultResolveComponentPath

  return (name) => {
    const path = resolveComponentPath(name)
    const loader = pages[path]

    if (!loader) {
      throw new Error(
        `Unable to locate Inertia page module for "${name}" at "${path}". Register the module via import.meta.glob() or provide a custom resolve function.`,
      )
    }

    return loader()
  }
}

export function defaultResolveComponentPath(name: string): string {
  return `./pages/${name}.tsx`
}
