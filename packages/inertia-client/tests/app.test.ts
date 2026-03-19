import { afterEach, describe, expect, it, mock } from 'bun:test'
import type { Page } from '@inertiajs/core'

let capturedOptions: Record<string, unknown> | undefined
const createInertiaAppMock = mock(async (options: Record<string, unknown>) => {
  capturedOptions = options
  return { head: [], body: '' }
})

await mock.module('@inertiajs/react', () => ({
  createInertiaApp: createInertiaAppMock,
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
