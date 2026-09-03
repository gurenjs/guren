import { createInertiaApp } from '@inertiajs/react'
import type { Page } from '@inertiajs/core'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { createPagesResolver as createPagesResolverFactory, type ResolveComponent } from './resolve'
import type { PageManifest } from './contracts'

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
  pageManifest?: PageManifest
  resolveComponentPath?: (name: string) => string
  setup?: (args: SetupArgs) => void
  progress?: {
    color?: string
  }
  page?: Page
}

const defaultSetup = ({ el, App, props }: SetupArgs) => {
  createRoot(el).render(React.createElement(App, props as any))
}

/** Start the Inertia client application. */
export function startInertiaClient(options: StartInertiaClientOptions): Promise<unknown> {
  const resolve =
    options.resolve ??
    createPagesResolverFactory({
      pages: options.pages,
      pageManifest: options.pageManifest,
      resolveComponentPath: options.resolveComponentPath,
    })

  const initialPage = options.page ?? getInitialPage()

  if (!initialPage) {
    throw new Error(
      'Unable to locate the initial Inertia page payload. Pass `page` to startInertiaClient() or ensure SSR embeds window.__INERTIA_PAGE__.',
    )
  }

  // Inertia v3's ComponentResolver expects the component itself (or a
  // module with `default`) — unwrap our PageModule promise explicitly.
  const resolveForInertia = async (name: string) => {
    const mod = await resolve(name)
    return (mod as { default?: React.ComponentType }).default ?? (mod as unknown as React.ComponentType)
  }

  return createInertiaApp({
    resolve: resolveForInertia,
    setup({ el, App, props }) {
      ; (options.setup ?? defaultSetup)({ el: el as HTMLElement, App: App as any, props: props as any })
    },
    progress: options.progress,
    page: initialPage,
  })
}


function getInitialPage(): Page | undefined {
  if (typeof window === 'undefined') {
    return undefined
  }

  const globalPage = (window as typeof window & { __INERTIA_PAGE__?: Page }).__INERTIA_PAGE__
  if (globalPage) {
    return globalPage
  }

  const scriptEl = typeof document.querySelector === 'function'
    ? document.querySelector('script[data-page="app"][type="application/json"]')
    : null
  if (scriptEl?.textContent) {
    try {
      return JSON.parse(scriptEl.textContent) as Page
    } catch (error) {
      console.warn('Failed to parse Inertia page script element:', error)
    }
  }

  // Legacy (pre-v3) fallback: page payload in the container's data-page attribute.
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
