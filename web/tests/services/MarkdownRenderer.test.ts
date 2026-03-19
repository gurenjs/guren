import { describe, expect, it, vi } from 'vitest'

const { codeToHtml } = vi.hoisted(() => ({
  codeToHtml: vi.fn(async () => '<pre>code</pre>'),
}))
vi.mock('shiki', () => ({ codeToHtml }))

import { renderMarkdownToHtml } from '../../app/Services/MarkdownRenderer.js'

describe('renderMarkdownToHtml', () => {
  it('renders alert blocks', async () => {
    const html = await renderMarkdownToHtml('> [!NOTE]\n> Hello there')
    expect(html).toContain('docs-alert--note')
    expect(html).toContain('Note')
  })

  it('renders code blocks with shiki', async () => {
    const html = await renderMarkdownToHtml('```js\nconsole.log("hi")\n```')
    expect(html).toContain('<pre>code</pre>')
    expect(codeToHtml).toHaveBeenCalled()
  })
})
