import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createControllerContext,
  createControllerModuleMock,
} from '../../../packages/testing/src/controller.js'
import type { Context } from '@guren/core'

vi.mock('@guren/core', () => createControllerModuleMock())

const { search } = vi.hoisted(() => ({ search: vi.fn() }))

// Replaced whole rather than partially: the real module reaches
// config/database.ts at import time, and that calls a `@guren/core` export the
// controller mock above does not carry. The controller's `instanceof` check
// resolves to the class defined here, since both go through this mock.
vi.mock('../../app/Services/DocSearchService.js', () => {
  class SearchIndexUnavailableError extends Error {
    readonly statusCode = 503
    constructor() {
      super('The docs search index has not been built.')
      this.name = 'SearchIndexUnavailableError'
    }
  }
  return { SearchIndexUnavailableError, docSearchService: { search } }
})

const { SearchIndexUnavailableError } = await import('../../app/Services/DocSearchService.js')
const { default: DocsSearchController } = await import(
  '../../app/Http/Controllers/DocsSearchController.js'
)

async function call(url: string): Promise<{ status: number; body: unknown }> {
  const controller = new DocsSearchController()
  controller.setContext(createControllerContext(url) as Context)
  try {
    const response = await controller.search()
    return { status: response.status, body: await response.json() }
  } catch (error) {
    // ValidationException carries its own status; the framework's handler turns
    // it into a response, so read it the way that handler would.
    const status = (error as { statusCode?: number }).statusCode
    if (status === undefined) {
      throw error
    }
    return { status, body: error }
  }
}

describe('DocsSearchController', () => {
  beforeEach(() => {
    search.mockReset()
    search.mockResolvedValue([])
  })

  it('passes the query and locale through to the service', async () => {
    await call('http://localhost/docs/search?q=routing&locale=ja')

    expect(search).toHaveBeenCalledWith('routing', 'ja')
  })

  it('defaults to English when no locale is given', async () => {
    await call('http://localhost/docs/search?q=routing')

    expect(search).toHaveBeenCalledWith('routing', 'en')
  })

  it('echoes the query alongside the results', async () => {
    search.mockResolvedValue([{ slug: 'routing', anchor: 'groups' }])
    const { status, body } = await call('http://localhost/docs/search?q=groups')

    expect(status).toBe(200)
    expect(body).toEqual({
      query: 'groups',
      locale: 'en',
      results: [{ slug: 'routing', anchor: 'groups' }],
    })
  })

  it('rejects a missing query', async () => {
    expect((await call('http://localhost/docs/search')).status).toBe(422)
    expect(search).not.toHaveBeenCalled()
  })

  it('rejects a query past the length cap', async () => {
    const { status } = await call(`http://localhost/docs/search?q=${'a'.repeat(65)}`)

    expect(status).toBe(422)
    expect(search).not.toHaveBeenCalled()
  })

  it('rejects a locale outside the two the docs are written in', async () => {
    expect((await call('http://localhost/docs/search?q=x&locale=fr')).status).toBe(422)
  })

  it('reports an unbuilt index as unavailable rather than as no results', async () => {
    search.mockRejectedValue(new SearchIndexUnavailableError())
    const { status, body } = await call('http://localhost/docs/search?q=routing')

    expect(status).toBe(503)
    expect(body).toHaveProperty('error')
    expect(body).not.toHaveProperty('results')
  })

  it('does not swallow an unexpected failure', async () => {
    search.mockRejectedValue(new Error('D1 is down'))

    await expect(call('http://localhost/docs/search?q=routing')).rejects.toThrow('D1 is down')
  })
})
