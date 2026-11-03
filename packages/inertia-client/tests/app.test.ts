import { afterEach, describe, expect, it, mock } from 'bun:test'
import type { Page } from '@inertiajs/core'
import * as realInertiaReact from '@inertiajs/react'
import * as realReactDomClient from 'react-dom/client'

let capturedOptions: Record<string, unknown> | undefined
const createInertiaAppMock = mock(async (options: Record<string, unknown>) => {
  capturedOptions = options
  return { head: [], body: '' }
})

// Spread the real module and override only what this file stubs: mock.module()
// is process-wide and not undone between files, so a hand-listed replacement
// breaks later files importing other exports.
await mock.module('@inertiajs/react', () => ({
  ...realInertiaReact,
  createInertiaApp: createInertiaAppMock,
}))

const mounts: string[] = []
await mock.module('react-dom/client', () => ({
  ...realReactDomClient,
  createRoot: () => {
    mounts.push('createRoot')
    return { render: () => {} }
  },
  hydrateRoot: () => {
    mounts.push('hydrateRoot')
  },
}))

const { startInertiaClient } = await import('../src/app')

type TestWindow = { __INERTIA_PAGE__?: Page }
type TestDocument = { getElementById: (id: string) => { getAttribute: (name: string) => string } | null }

const globalRef = globalThis as {
  window?: TestWindow
  document?: TestDocument
}
const originalWindow = globalRef.window
const originalDocument = globalRef.document

afterEach(() => {
  capturedOptions = undefined
  mounts.length = 0
  createInertiaAppMock.mockClear()
  if (originalWindow === undefined) {
    delete globalRef.window
  } else {
    globalRef.window = originalWindow
  }
  if (originalDocument === undefined) {
    delete globalRef.document
  } else {
    globalRef.document = originalDocument
  }
})

describe('startInertiaClient', () => {
  it('throws when no initial page is available', async () => {
    expect(() =>
      startInertiaClient({
        resolve: async () => ({ default: () => null }),
        setup: () => {},
      }),
    ).toThrow('Unable to locate the initial Inertia page payload')
  })

  it('uses window.__INERTIA_PAGE__ when available', async () => {
    const page: Page = {
      component: 'Dashboard',
      props: { count: 1, errors: {} },
      url: '/dashboard',
      version: null,
      clearHistory: false,
      encryptHistory: false,
      rememberedState: {},
    rescuedProps: [],
      flash: {},
    }

    globalRef.window = { __INERTIA_PAGE__: page }
    globalRef.document = { getElementById: () => null }

    await startInertiaClient({
      resolve: async () => ({ default: () => null }),
      setup: () => {},
    })

    expect(capturedOptions?.page).toEqual(page)
  })

  it('parses the initial page from the data-page attribute', async () => {
    const page: Page = {
      component: 'Home',
      props: { ready: true, errors: {} },
      url: '/',
      version: null,
      clearHistory: false,
      encryptHistory: false,
      rememberedState: {},
    rescuedProps: [],
      flash: {},
    }

    globalRef.window = {}
    globalRef.document = {
      getElementById: () => ({
        getAttribute: () => JSON.stringify(page),
      }),
    }

    await startInertiaClient({
      resolve: async () => ({ default: () => null }),
      setup: () => {},
    })

    expect(capturedOptions?.page).toEqual(page)
  })
})

describe('the default setup', () => {
  const page: Page = {
    component: 'Login',
    props: { errors: {} },
    url: '/login',
    version: null,
    clearHistory: false,
    encryptHistory: false,
    rememberedState: {},
    rescuedProps: [],
    flash: {},
  }

  async function mountInto(serverRendered: boolean): Promise<string[]> {
    await startInertiaClient({ page, resolve: async () => ({ default: () => null }) })
    const setup = capturedOptions?.setup as (args: { el: unknown; App: unknown; props: unknown }) => void
    setup({
      el: { hasAttribute: (name: string) => serverRendered && name === 'data-server-rendered', querySelectorAll: () => [] },
      App: () => null,
      props: {},
    })
    return [...mounts]
  }

  // A fresh root would replace the server's markup, and what was typed into it before hydration.
  it('hydrates markup the server rendered', async () => {
    expect(await mountInto(true)).toEqual(['hydrateRoot'])
  })

  it('renders a fresh root into an empty container', async () => {
    expect(await mountInto(false)).toEqual(['createRoot'])
  })
})
