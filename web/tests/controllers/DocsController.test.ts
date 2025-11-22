import { afterEach, describe, expect, it, vi } from 'vitest'
import { createControllerContext, readInertiaResponse, type ControllerContext } from '@guren/testing'
import type { Context } from '@guren/server'
import type { DocCategoryGroup, DocPage } from '../../app/Services/DocsService.js'
import { createControllerModuleMock } from '../../../packages/testing/dist/index.js'

vi.mock('@guren/server', () => createControllerModuleMock())

import DocsController from '../../app/Http/Controllers/DocsController.js'
import { docsService } from '../../app/Services/DocsService.js'

function createDocsContext(url: string): Context {
  const ctx = createControllerContext(url) as ControllerContext & {
    req: ControllerContext['req'] & {
      param?: (name: string) => string | undefined
    }
  }
  const { pathname } = new URL(url)
  const segments = pathname.split('/').filter(Boolean)
  const [, category, slug] = segments
  ctx.req.param = (name: string) => {
    if (name === 'category') {
      return category ?? undefined
    }

    if (name === 'slug') {
      return slug ?? undefined
    }

    return undefined
  }

  return ctx as unknown as Context
}

describe('DocsController', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('renders categories on the docs index', async () => {
    const categories: DocCategoryGroup[] = [
      {
        category: 'guides',
        title: 'Guides',
        docs: [
          {
            slug: 'getting-started',
            title: 'Getting Started',
            description: 'Welcome aboard',
          },
        ],
      },
    ]
    vi.spyOn(docsService, 'listDocs').mockResolvedValue(categories)

    const controller = new DocsController()
    const ctx = createDocsContext('http://guren.dev/docs')
    controller.setContext(ctx)

    const response = await controller.index()
    const { payload } = await readInertiaResponse(response)

    expect(docsService.listDocs).toHaveBeenCalledTimes(1)
    expect(payload.component).toBe('Docs/Index')
    expect(payload.props.categories).toEqual(categories)
    expect(payload.url).toBe('/docs')
  })

  it('renders a documentation page when found', async () => {
    const categories: DocCategoryGroup[] = []
    const docPage: DocPage = {
      category: 'guides',
      slug: 'routing',
      title: 'Routing',
      description: 'Routing basics',
      html: '<p>Routing</p>',
    }
    vi.spyOn(docsService, 'listDocs').mockResolvedValue(categories)
    vi.spyOn(docsService, 'getDoc').mockResolvedValue(docPage)

    const controller = new DocsController()
    const ctx = createDocsContext('http://guren.dev/docs/guides/routing')
    controller.setContext(ctx)

    const response = await controller.show()
    const { payload } = await readInertiaResponse(response)

    expect(docsService.getDoc).toHaveBeenCalledWith('guides', 'routing')
    expect(response.status).toBe(200)
    expect(payload.props.doc).toEqual(docPage)
    expect(payload.props.active).toEqual({ category: 'guides', slug: 'routing' })
    expect(payload.props.categories).toEqual(categories)
  })

  it('returns 404 with normalized active info when page is missing', async () => {
    vi.spyOn(docsService, 'listDocs').mockResolvedValue([])
    vi.spyOn(docsService, 'getDoc').mockResolvedValue(null)

    const controller = new DocsController()
    const ctx = createDocsContext('http://guren.dev/docs/guides/missing')
    controller.setContext(ctx)

    const response = await controller.show()
    const { payload } = await readInertiaResponse(response)

    expect(response.status).toBe(404)
    expect(payload.props.doc).toBeNull()
    expect(payload.props.active).toEqual({ category: 'guides', slug: 'missing' })
  })
})
