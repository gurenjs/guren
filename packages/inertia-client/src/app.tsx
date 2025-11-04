import { createInertiaApp } from '@inertiajs/react'
import type { Page } from '@inertiajs/core'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { createPagesResolver as createPagesResolverFactory, type ResolveComponent } from './resolve'

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
  const resolve =
    options.resolve ??
    createPagesResolverFactory({
      pages: options.pages,
      resolveComponentPath: options.resolveComponentPath,
    })

  return createInertiaApp({
    resolve,
    setup({ el, App, props }) {
      ; (options.setup ?? defaultSetup)({ el, App: App as any, props: props as any })
    },
    progress: options.progress,
    page: options.page ?? getInitialPage(),
  })
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
