import { createInertiaApp } from '@inertiajs/react'
import type { Page } from '@inertiajs/core'
import React from 'react'
import { renderToString } from 'react-dom/server'
import { createPagesResolver as createPagesResolverFactory, type ResolveComponent } from './resolve'

type ServerSetupArgs = {
  App: React.ComponentType<any>
  props: {
    initialPage: Page
    initialComponent: React.ComponentType
    resolveComponent: ResolveComponent
    titleCallback?: (title: string) => string
    onHeadUpdate: (elements: string[]) => void
  }
}

export interface RenderInertiaServerOptions {
  page: Page
  resolve?: ResolveComponent
  pages?: Record<string, () => Promise<unknown>>
  resolveComponentPath?: (name: string) => string
  render?: typeof renderToString
  setup?: (args: ServerSetupArgs) => React.ReactElement
}

export interface RenderInertiaServerResult {
  head: string[]
  body: string
}

const defaultRender = renderToString

const defaultSetup = ({ App, props }: ServerSetupArgs) => React.createElement(App, props as any)

export async function renderInertiaServer(options: RenderInertiaServerOptions): Promise<RenderInertiaServerResult> {
  const resolve =
    options.resolve ??
    createPagesResolverFactory({
      pages: options.pages,
      resolveComponentPath: options.resolveComponentPath,
    })

  const renderPage = options.render ?? defaultRender
  const setup = options.setup ?? defaultSetup

  const result = await createInertiaApp({
    page: options.page,
    resolve,
    render: renderPage,
    setup({ App, props }) {
      return setup({ App: App as any, props: props as any })
    },
  })

  return {
    head: result.head ?? [],
    body: result.body,
  }
}
