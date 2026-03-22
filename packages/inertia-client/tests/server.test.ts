import { describe, expect, it, mock } from 'bun:test'
import React from 'react'
import type { Page } from '@inertiajs/core'

const createInertiaAppMock = mock(async (options: {
  page: unknown
  resolve: (name: string) => Promise<{ default: unknown }>
  render?: (app: unknown) => string
  setup: (args: { App: unknown; props: unknown }) => React.ReactElement
}) => {
  const componentName =
    typeof options.page === 'object' && options.page !== null && 'component' in options.page
      ? (options.page as { component: string }).component
      : 'Dashboard'
  const resolved = await options.resolve(componentName)
  const app = options.setup({ App: resolved.default, props: { initialPage: options.page } })
  const body = options.render ? options.render(app) : ''
  return { head: ['<title>Test</title>'], body }
})

await mock.module('@inertiajs/react', () => ({
  createInertiaApp: createInertiaAppMock,
}))

const { renderInertiaServer } = await import('../src/server')

describe('renderInertiaServer', () => {
  it('returns head and body from the Inertia renderer', async () => {
    const page: Page = {
      component: 'Dashboard',
      props: { name: 'Ada', errors: {} },
      url: '/dashboard',
      version: null,
      clearHistory: false,
      encryptHistory: false,
      rememberedState: {},
      flash: {},
    }
    const pages = {
      './pages/Dashboard.tsx': async () => ({ default: () => null }),
    }

    const result = await renderInertiaServer({
      page,
      pages,
      render: () => '<main>Rendered</main>',
      setup: () => React.createElement('div'),
    })

    expect(result.head).toEqual(['<title>Test</title>'])
    expect(result.body).toBe('<main>Rendered</main>')
  })

  it('supports custom resolveComponentPath', async () => {
    const page: Page = {
      component: 'Overview',
      props: { errors: {} },
      url: '/overview',
      version: null,
      clearHistory: false,
      encryptHistory: false,
      rememberedState: {},
      flash: {},
    }
    const pages = {
      './custom/Overview.tsx': async () => ({ default: () => null }),
    }

    await renderInertiaServer({
      page,
      pages,
      resolveComponentPath: (name) => `./custom/${name}.tsx`,
      render: () => '<div />',
      setup: () => React.createElement('div'),
    })

    expect(createInertiaAppMock).toHaveBeenCalled()
  })
})
