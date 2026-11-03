import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it, vi } from 'vitest'

import { htmlToText } from '../../app/Services/search-sections.js'
import { INTERACTIVE_DIAGRAMS } from '../../config/interactive-diagrams.js'
import { MIDDLEWARE_STEPS, ORDERS } from '../../resources/js/components/diagrams/middleware-order-steps.js'
import { PLAN_LIFECYCLE_STAGES } from '../../resources/js/components/diagrams/plan-lifecycle-stages.js'
import { INTERACTIVE_DIAGRAM_LOADERS } from '../../resources/js/components/diagrams/registry.js'

vi.mock('shiki', () => ({ codeToHtml: vi.fn(async () => '<pre>code</pre>') }))

const { renderMarkdownToHtml } = await import('../../app/Services/MarkdownRenderer.js')

const FENCE = '```mermaid\nflowchart LR\n  A["plan.json"] --> B\n```'

describe('interactive diagrams', () => {
  it('wraps the mermaid fence under a marker in the placeholder the docs page mounts into', async () => {
    const html = await renderMarkdownToHtml(`Intro.\n\n<!-- interactive: plan-lifecycle -->\n\n${FENCE}\n`)
    expect(html).toMatch(
      /<div class="doc-interactive" data-interactive="plan-lifecycle"><pre class="mermaid">[\s\S]*<\/pre><\/div>/u,
    )
    expect(html).not.toContain('<!--')
  })

  it('leaves a fence with no marker as a plain mermaid diagram', async () => {
    const html = await renderMarkdownToHtml(`${FENCE}\n`)
    expect(html).not.toContain('doc-interactive')
  })

  it('refuses a marker naming no registered diagram', async () => {
    await expect(renderMarkdownToHtml(`<!-- interactive: nope -->\n\n${FENCE}\n`)).rejects.toThrow(
      'Unknown interactive diagram "nope"',
    )
  })

  it('refuses a marker with no mermaid fence under it, which would leave GitHub readers nothing', async () => {
    await expect(renderMarkdownToHtml('<!-- interactive: plan-lifecycle -->\n\nJust prose.\n')).rejects.toThrow(
      'must sit directly above a mermaid fence',
    )
  })

  it('keeps a marker shown inside a code block as text', async () => {
    const html = await renderMarkdownToHtml('    <!-- interactive: nope -->\n')
    expect(html).not.toContain('doc-interactive')
  })

  it('adds no searchable text beyond what the fence held', async () => {
    const html = await renderMarkdownToHtml(`Intro.\n\n<!-- interactive: plan-lifecycle -->\n\n${FENCE}\n`)
    expect(htmlToText(html).trim()).toBe(htmlToText(await renderMarkdownToHtml(`Intro.\n\n${FENCE}\n`)).trim())
  })

  it('has a client loader for every name the server accepts', () => {
    expect(Object.keys(INTERACTIVE_DIAGRAM_LOADERS).sort()).toEqual([...INTERACTIVE_DIAGRAMS].sort())
  })

  it.each(['en', 'ja'] as const)('upgrades the %s implementation plans guide', async (locale) => {
    const path = fileURLToPath(new URL(`../../../docs/${locale}/guides/implementation-plans.md`, import.meta.url))
    const html = await renderMarkdownToHtml(readFileSync(path, 'utf8'), { locale, category: 'guides' })
    expect(html.match(/data-interactive="plan-lifecycle"/gu)).toHaveLength(1)
    for (const stage of PLAN_LIFECYCLE_STAGES) {
      expect(html).toContain(`id="${stage.anchor[locale]}"`)
    }
  })

  it.each(['en', 'ja'] as const)('upgrades the %s middleware guide over a flowchart in the same orders', async (locale) => {
    const path = fileURLToPath(new URL(`../../../docs/${locale}/guides/middleware.md`, import.meta.url))
    const html = await renderMarkdownToHtml(readFileSync(path, 'utf8'), { locale, category: 'guides' })
    const block = /<div class="doc-interactive" data-interactive="middleware-order"><pre class="mermaid">([\s\S]*?)<\/pre>/u.exec(html)
    expect(block).not.toBeNull()
    // The flowchart is the no-JS fallback: each subgraph's chain must list the diagram's steps in its order.
    const source = block![1].replace(/&gt;/gu, '>').replace(/&#39;/gu, "'").replace(/&quot;/gu, '"')
    const labels = new Map([...source.matchAll(/(\w+)\["([^"]*)"\]/gu)].map(([, node, label]) => [node, label]))
    // Split on the arrow as a string: the chain is mermaid, not HTML.
    const chain = (prefix: string) =>
      source
        .split('\n')
        .map((line) => line.split('-->').map((node) => node.trim()))
        .find((nodes) => nodes.length > 1 && nodes.every((node) => new RegExp(`^${prefix}\\d$`, 'u').test(node)))!
    const token = (id: string) => MIDDLEWARE_STEPS[id].code.replace(/^\.middleware\((.*)\)$/u, '$1')

    const run = chain('A')
    expect(run).toHaveLength(ORDERS.run.length)
    ORDERS.run.forEach((id, index) => {
      if (MIDDLEWARE_STEPS[id].kind !== 'router') expect(labels.get(run[index])).toContain(token(id))
    })
    expect(labels.get(run[ORDERS.run.indexOf('validation')])).toContain('body / params / query')

    const written = chain('W')
    expect(written.map((node) => labels.get(node))).toEqual(
      ORDERS.written.filter((id) => MIDDLEWARE_STEPS[id].kind !== 'router').map((id) => expect.stringContaining(token(id))),
    )
  })
})
