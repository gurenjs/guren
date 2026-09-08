import { createInertiaApp } from '@inertiajs/react'
import type { Page } from '@inertiajs/core'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { createPagesResolver as createPagesResolverFactory, type ResolveComponent } from './resolve'
import type { PageManifest } from './contracts'
import {
  createPrototypeHttpClient,
  isPrototypeDefinition,
  resetPrototypeState,
  resolveInitialPage,
  type AnyPrototypeDefinition,
} from './prototype'

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
  /**
   * Prototype mode (RFC 0021): the fixture module answers every visit in the
   * browser, so no server is involved. Wire it behind the build-time
   * `import.meta.env.GUREN_PROTOTYPE` so the production bundle drops it:
   * `prototype: import.meta.env.GUREN_PROTOTYPE ? { load: () => import('./prototype'), base: import.meta.env.BASE_URL } : undefined`
   */
  prototype?: PrototypeLoader | PrototypeClientOptions
}

export type PrototypeModule = { default: AnyPrototypeDefinition } | AnyPrototypeDefinition
export type PrototypeLoader = () => Promise<PrototypeModule>

export interface PrototypeClientOptions {
  load: PrototypeLoader
  /** Vite's `base` (`import.meta.env.BASE_URL`) for a build hosted under a subpath. */
  base?: string
}

/** Query flag that discards the persisted prototype state and reloads the URL without it. */
export const PROTOTYPE_RESET_FLAG = 'prototype.reset'

const defaultSetup = ({ el, App, props }: SetupArgs) => {
  createRoot(el).render(React.createElement(App, props as any))
}

/** Start the Inertia client application. */
export function startInertiaClient(options: StartInertiaClientOptions): Promise<unknown> {
  if (options.prototype) {
    return startPrototypeClient(options, options.prototype)
  }

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

async function startPrototypeClient(
  options: StartInertiaClientOptions,
  prototype: PrototypeLoader | PrototypeClientOptions,
): Promise<unknown> {
  const { load, base } = typeof prototype === 'function' ? { load: prototype, base: undefined } : prototype

  if (typeof window !== 'undefined' && window.location) {
    const url = new URL(window.location.href)
    if (url.searchParams.has(PROTOTYPE_RESET_FLAG)) {
      resetPrototypeState()
      url.searchParams.delete(PROTOTYPE_RESET_FLAG)
      window.location.replace(url.href)
      return new Promise(() => {})
    }
  }

  const loaded = await load()
  const definition = isPrototypeDefinition(loaded) ? loaded : (loaded as { default: AnyPrototypeDefinition }).default
  if (!isPrototypeDefinition(definition)) {
    throw new Error('The prototype module must export the result of definePrototype() as its default export.')
  }

  const http = createPrototypeHttpClient(definition, { base })
  const initialPage = options.page ?? (await resolveInitialPage(http, window.location))

  const resolve =
    options.resolve ??
    createPagesResolverFactory({
      pages: options.pages,
      pageManifest: options.pageManifest,
      resolveComponentPath: options.resolveComponentPath,
    })
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
    http,
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
