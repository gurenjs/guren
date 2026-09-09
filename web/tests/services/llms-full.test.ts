import { describe, expect, it, vi } from 'vitest'
import type { DocCategoryGroup } from '../../app/Services/docs-config.js'
import { buildLlmsFull } from '../../app/Services/llms-full.js'

const routingDoc = { slug: 'routing', title: 'Routing', description: 'Define routes' }
const retiredDoc = { slug: 'retired', title: 'Retired' }
const categories: DocCategoryGroup[] = [
  {
    category: 'guides',
    title: 'Guides',
    docs: [routingDoc, retiredDoc],
    sections: [{ title: 'The Basics', docs: [routingDoc, retiredDoc] }],
  },
]

describe('buildLlmsFull', () => {
  it('should concatenate every English doc under its canonical URL', async () => {
    const getRawMarkdown = vi.fn(async (_category: string, slug: string) =>
      slug === 'routing' ? '# Routing\n\nDefine routes.\n' : null,
    )

    const body = await buildLlmsFull({ listDocs: async () => categories, getRawMarkdown })

    expect(getRawMarkdown).toHaveBeenCalledWith('guides', 'routing', 'en')
    expect(body).toContain('# Guren — Full Documentation')
    expect(body).toContain('<!-- https://guren.dev/docs/guides/routing -->')
    expect(body).toContain('# Routing\n\nDefine routes.')
    // A doc whose source is gone is skipped, not rendered as an empty entry.
    expect(body).not.toContain('retired')
  })
})
