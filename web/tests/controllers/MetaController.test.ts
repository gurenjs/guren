import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createControllerContext,
  createControllerModuleMock,
} from '../../../packages/testing/src/controller.js'
import type { Context } from '@guren/core'
import type { DocCategoryGroup } from '../../app/Services/DocsService.js'

vi.mock('@guren/core', () => createControllerModuleMock())

import MetaController from '../../app/Http/Controllers/MetaController.js'
import { docsService } from '../../app/Services/DocsService.js'

const routingDoc = { slug: 'routing', title: 'Routing', description: 'Define routes' }
const categories: DocCategoryGroup[] = [
  {
    category: 'guides',
    title: 'Guides',
    docs: [routingDoc],
    sections: [{ title: 'The Basics', docs: [routingDoc] }],
  },
]

function createController(url: string): MetaController {
  const controller = new MetaController()
  controller.setContext(createControllerContext(url) as unknown as Context)
  return controller
}

describe('MetaController', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('serves a sitemap with hreflang alternates for docs pages', async () => {
    vi.spyOn(docsService, 'listDocs').mockResolvedValue(categories)

    const response = await createController('http://guren.dev/sitemap.xml').sitemap()
    const body = await response.text()

    expect(response.headers.get('Content-Type')).toContain('application/xml')
    expect(body).toContain('<loc>https://gurenjs.vercel.app/docs/guides/routing</loc>')
    expect(body).toContain('<loc>https://gurenjs.vercel.app/docs/ja/guides/routing</loc>')
    expect(body).toContain('hreflang="ja" href="https://gurenjs.vercel.app/docs/ja/guides/routing"')
    expect(body).toContain('hreflang="x-default"')
  })

  it('serves llms.txt with markdown links per doc', async () => {
    vi.spyOn(docsService, 'listDocs').mockResolvedValue(categories)

    const response = await createController('http://guren.dev/llms.txt').llms()
    const body = await response.text()

    expect(response.headers.get('Content-Type')).toContain('text/plain')
    expect(body).toContain('# Guren')
    expect(body).toContain('## Guides')
    expect(body).toContain('- [Routing](https://gurenjs.vercel.app/docs/guides/routing.md): Define routes')
    expect(body).toContain('/llms-full.txt')
  })

  it('serves llms-full.txt with concatenated markdown', async () => {
    vi.spyOn(docsService, 'listDocs').mockResolvedValue(categories)
    vi.spyOn(docsService, 'getRawMarkdown').mockResolvedValue('# Routing\n\nDefine routes.')

    const response = await createController('http://guren.dev/llms-full.txt').llmsFull()
    const body = await response.text()

    expect(docsService.getRawMarkdown).toHaveBeenCalledWith('guides', 'routing', 'en')
    expect(body).toContain('# Guren — Full Documentation')
    expect(body).toContain('<!-- https://gurenjs.vercel.app/docs/guides/routing -->')
    expect(body).toContain('# Routing')
  })
})
