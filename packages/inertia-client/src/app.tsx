import { createInertiaApp } from '@inertiajs/react'
import type { Page } from '@inertiajs/core'
import React from 'react'
import { createRoot } from 'react-dom/client'

type PageModule = { default: React.ComponentType<any> }
type PageLoader = () => Promise<PageModule>

type ResolveComponent = (name: string) => Promise<PageModule>

type SetupArgs = {
  el: HTMLElement
  App: React.ComponentType<any>
  props: {
    initialPage: Page
    initialComponent: React.ComponentType
    resolveComponent: ResolveComponent
    titleCallback?: (title: string) => string
    onHeadUpdate?: (elements: string[]) => void
  }
}

export interface StartInertiaClientOptions {
  resolve?: ResolveComponent
  pages?: Record<string, () => Promise<unknown>>
  resolveComponentPath?: (name: string) => string
  setup?: (args: SetupArgs) => void
  progress?: {
    color?: string
  }
  page?: Page
}

/**
 * The default setup function for rendering the Inertia app.
 * @param param0 The setup arguments containing the element, App component, and props.
 */
const defaultSetup = ({ el, App, props }: SetupArgs) => {
  createRoot(el).render(React.createElement(App, props as any))
}

/**
 * Start the Inertia client application.
 * @param options The options for starting the Inertia client.
 * @returns A promise that resolves when the Inertia app is created.
 */
export function startInertiaClient(options: StartInertiaClientOptions): Promise<unknown> {
  const resolve = options.resolve ?? createPagesResolver(options)

  return createInertiaApp({
    resolve,
    setup({ el, App, props }) {
      ; (options.setup ?? defaultSetup)({ el, App: App as any, props: props as any })
    },
    progress: options.progress,
    page: options.page ?? getInitialPage(),
  })
}

function createPagesResolver(options: StartInertiaClientOptions): ResolveComponent {
  if (!options.pages) {
    throw new Error('startInertiaClient requires either a `resolve` function or a `pages` map created via import.meta.glob().')
  }

  const pages = options.pages as Record<string, PageLoader>
  const resolveComponentPath = options.resolveComponentPath ?? defaultResolveComponentPath

  return (name) => {
    const path = resolveComponentPath(name)
    const loader = pages[path]

    if (!loader) {
      throw new Error(`Unable to locate Inertia page module for "${name}" at "${path}". Register the module via import.meta.glob() or provide a custom resolve function.`)
    }

    return loader()
  }
}

function defaultResolveComponentPath(name: string): string {
  return `./pages/${name}.tsx`
}

/**
 * Get the initial Inertia page from the global variable or the DOM.
 * @returns The initial Inertia page or undefined if not found.
 */
function getInitialPage(): Page | undefined {
  if (typeof window === 'undefined') {
    return undefined
  }

  const globalPage = (window as typeof window & { __INERTIA_PAGE__?: Page }).__INERTIA_PAGE__
  if (globalPage) {
    return globalPage
  }

  const appEl = document.getElementById('app')
  const dataset = appEl?.getAttribute('data-page')
  if (!dataset) {
    return undefined
  }

  try {
    return JSON.parse(dataset) as Page
  } catch (error) {
    console.warn('Failed to parse Inertia page dataset:', error)
    return undefined
  }
}
