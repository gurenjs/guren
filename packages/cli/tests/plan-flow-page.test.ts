import { describe, expect, test } from 'bun:test'

import type { PlanFlowLayout } from '../src/plan/flow'
import * as flowPage from '../src/plan/page/flow'
import { buildPlanPayload, planLinks, planTemplateSource, renderPlanHtml, type PlanPagePayload } from '../src/plan/render'
import { PlanDraftSchema, type PlanDraft } from '../src/plan/schema'
import { loadCommentsPlan, PAYLOADS, planPageData } from './plan-fixture'
import { pageFunctionSource, planPageSource, usePageDocument } from './plan-page-dom'

const script = planPageSource()

// Added here rather than to `comments.plan.json`: the schema, identity and validate
// tests read that file too. One cycle (validate -> page), one async edge, one self-loop.
const FLOW = {
  id: 'flow.comment',
  change: { kind: 'add' },
  title: 'Leaving a comment',
  description: 'What happens between a reader typing and the comment appearing.',
  nodes: [
    { id: 'reader', label: 'A signed-in reader', kind: 'actor' },
    { id: 'page', label: 'The post page', kind: 'page', element: 'view.posts.show' },
    { id: 'route', label: 'comments.store', kind: 'route', element: 'route.comments.store' },
    { id: 'validate', label: 'Comment payload', kind: 'decision', element: 'validator.comment' },
    { id: 'store', label: 'CommentController store', kind: 'action', element: 'action.comments.store' },
    { id: 'row', label: 'A comments row', kind: 'store', element: 'model.comment' },
    { id: 'author', label: 'Notify the author', kind: 'job' },
  ],
  edges: [
    { from: 'reader', to: 'page' },
    { from: 'page', to: 'route', label: 'submits' },
    { from: 'route', to: 'validate' },
    { from: 'validate', to: 'store', label: 'valid' },
    { from: 'validate', to: 'page', label: '422 with errors' },
    { from: 'store', to: 'row' },
    { from: 'store', to: 'author', kind: 'async' },
    { from: 'store', to: 'store', label: 'retries' },
  ],
}

const SECOND_FLOW = {
  id: 'flow.moderate',
  change: { kind: 'existing' },
  title: 'Moderating',
  nodes: [
    { id: 'a', label: 'Queue', kind: 'page' },
    { id: 'b', label: 'Review', kind: 'decision' },
    { id: 'c', label: 'Publish', kind: 'action' },
  ],
  // Two cycles, so two back edges in one picture.
  edges: [
    { from: 'a', to: 'b' },
    { from: 'b', to: 'c' },
    { from: 'b', to: 'a', label: 'rejected' },
    { from: 'c', to: 'a', label: 'next' },
  ],
}

function planWithFlows(flows: unknown[] = [FLOW, SECOND_FLOW]): PlanDraft {
  return PlanDraftSchema.parse({ ...loadCommentsPlan(), flows })
}

function payloadOf(plan: PlanDraft): PlanPagePayload {
  return planPageData(renderPlanHtml({ plan }))
}

/** One flow as the page is handed it. */
function layoutOf(flow: unknown): PlanFlowLayout {
  return buildPlanPayload({ plan: planWithFlows([flow]) }).flows[0]
}

const functionSource = (name: string): string => pageFunctionSource(script, name)

class FakeNode {
  readonly attributes: Record<string, string> = {}
  readonly children: FakeNode[] = []
  textContent = ''

  constructor(readonly tag: string) {}

  setAttribute(name: string, value: string): void {
    this.attributes[name] = String(value)
  }

  appendChild(child: FakeNode): FakeNode {
    this.children.push(child)
    return child
  }

  all(): FakeNode[] {
    return [this, ...this.children.flatMap((child) => child.all())]
  }

  withTag(tag: string): FakeNode[] {
    return this.all().filter((node) => node.tag === tag)
  }

  withClass(name: string): FakeNode[] {
    return this.all().filter((node) => (node.attributes.class ?? '').split(' ').includes(name))
  }
}

// The page's own drawing, imported; this answers the one DOM call it makes.
usePageDocument({ createElementNS: (_namespace: string, tag: string) => new FakeNode(tag) })

const { flowBlocked, wrapSvgText, FLOW_NODE_H, FLOW_GAP_Y } = flowPage

/** Every element id of the fixture plan, as the page's own index holds them. */
const DECLARED = Object.fromEntries(buildPlanPayload({ plan: planWithFlows() }).elements.map((element) => [element.id, true]))

function drawFlow(flow: PlanFlowLayout, declared: object = DECLARED): FakeNode {
  return flowPage.drawFlow(flow, declared, `Flow: ${flow.title}`) as unknown as FakeNode
}

function laneOf(edge: FakeNode): number {
  const match = edge.attributes.d.match(/ V ([\d.]+) H /)
  if (!match) throw new Error(`not routed through a lane: ${edge.attributes.d}`)
  return Number(match[1])
}

describe('the flows a plan page is handed', () => {
  test('should carry one layout per flow, in the plan order', () => {
    const payload = payloadOf(planWithFlows())

    expect(payload.flows.map((flow) => flow.id)).toEqual(['flow.comment', 'flow.moderate'])
    expect(payload.flows[0].change).toBe('add')
  })

  test('should carry none for a plan that declares none', () => {
    expect(payloadOf(planWithFlows([])).flows).toEqual([])
  })

  test('should link a flow to the element its node names', () => {
    expect(planLinks(planWithFlows())).toContainEqual({
      from: 'flow.comment',
      to: 'route.comments.store',
      label: 'comments.store',
    })
  })

  test('should list a flow among the elements, so a check result can name it', () => {
    const payload = buildPlanPayload({ plan: planWithFlows() })

    expect(payload.elements.map((element) => element.id)).toContain('flow.comment')
  })
})

describe('drawFlow', () => {
  const [comment, moderate] = payloadOf(planWithFlows()).flows

  test('should draw one svg per flow', () => {
    const drawn = [comment, moderate].map((flow) => drawFlow(flow))

    expect(drawn.map((svg) => svg.tag)).toEqual(['svg', 'svg'])
    expect(drawn.map((svg) => svg.attributes['aria-label'])).toEqual(['Flow: Leaving a comment', 'Flow: Moderating'])
  })

  test('should draw every node with its kind and its label', () => {
    const nodes = drawFlow(comment).withClass('node')

    expect(nodes).toHaveLength(7)
    expect(nodes[0].children.map((child) => `${child.tag}:${child.textContent}`)).toEqual([
      'rect:',
      'title:A signed-in reader',
      'text:actor',
      'text:A signed-in reader',
    ])
    expect(nodes[0].children[0].attributes.class).toBe('box actor')
  })

  test('should link a node that names an element to that element card', () => {
    const svg = drawFlow(comment)
    const anchors = svg.withTag('a')

    expect(anchors.map((anchor) => anchor.attributes.href)).toEqual([
      '#el-view.posts.show',
      '#el-route.comments.store',
      '#el-validator.comment',
      '#el-action.comments.store',
      '#el-model.comment',
    ])
    expect(anchors.every((anchor) => anchor.children[0].attributes.class === 'node')).toBe(true)
  })

  test('should not link a node to an element the plan does not declare', () => {
    const svg = drawFlow({
      ...comment,
      nodes: comment.nodes.map((node) => ({ ...node, element: 'route.not.declared' })),
    })

    expect(svg.withTag('a')).toEqual([])
  })

  test('should leave a node with no element as plain text', () => {
    const svg = drawFlow(comment)
    const direct = svg.children.filter((child) => child.attributes.class === 'node')

    expect(direct.map((node) => node.children[3].textContent)).toEqual(['A signed-in reader', 'Notify the author'])
  })

  test('should not link an element id the anchor gate refuses', () => {
    // Declared, so the gate is the only thing between this id and an href.
    const hostile = 'javascript:alert(1)//" onload="'
    const svg = drawFlow({ ...comment, nodes: comment.nodes.map((node) => ({ ...node, element: hostile })) }, { [hostile]: true })

    expect(svg.withTag('a')).toEqual([])
    expect(svg.withClass('node')).toHaveLength(7)
  })

  test('should dash an async edge and no other', () => {
    const svg = drawFlow(comment)

    expect(svg.withClass('async')).toHaveLength(1)
    expect(svg.withClass('async')[0].attributes.class).toBe('edge async')
  })

  test('should not draw a step looping to itself', () => {
    const svg = drawFlow(comment)

    expect(svg.withClass('edge')).toHaveLength(7)
    expect(svg.all().map((node) => node.textContent)).not.toContain('retries')
  })

  test('should not draw a self-loop a payload built elsewhere still carries', () => {
    const svg = drawFlow({ ...comment, edges: [{ from: 'store', to: 'store', kind: 'sync', back: false }] })

    expect(svg.withClass('edge')).toEqual([])
  })

  test('should mark the edge that closes a cycle and route it under the grid', () => {
    const svg = drawFlow(comment)
    const back = svg.withClass('edge').filter((edge) => edge.attributes.class.includes('back'))
    const forward = svg.withClass('edge').filter((edge) => !edge.attributes.class.includes('back'))
    const lowest = Math.max(
      ...svg.withTag('rect').map((rect) => Number(rect.attributes.y) + Number(rect.attributes.height)),
    )

    expect(back).toHaveLength(1)
    expect(back[0].tag).toBe('path')
    expect(laneOf(back[0])).toBeGreaterThan(lowest)
    expect(Number(svg.attributes.height)).toBeGreaterThan(laneOf(back[0]))
    expect(forward.every((edge) => edge.tag === 'line')).toBe(true)
    expect(svg.withClass('arrow').filter((head) => head.attributes.class === 'arrow back')).toHaveLength(1)
  })

  test('should give each back edge a lane of its own', () => {
    const back = drawFlow(moderate).withClass('back').filter((edge) => edge.tag === 'path')

    expect(back).toHaveLength(2)
    expect(laneOf(back[0])).not.toBe(laneOf(back[1]))
  })

  test('should run the stems of a routed edge between the columns, through no box', () => {
    // `c` and `d` stand under `a` and `b`, where a stem dropped from a box centre would cross them.
    const stacked = layoutOf({
          ...SECOND_FLOW,
          nodes: [...SECOND_FLOW.nodes, { id: 'd', label: 'Below', kind: 'job' }, { id: 'e', label: 'Below too', kind: 'job' }],
          edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }, { from: 'd', to: 'e' }],
        })
    const svg = drawFlow(stacked)
    const rects = svg.withTag('rect')
    const stems = [...svg.withClass('back')[0].attributes.d.matchAll(/H ([\d.]+) V/g)].map((match) => Number(match[1]))

    expect(stems).toHaveLength(2)
    for (const x of stems) {
      expect(rects.some((rect) => x >= Number(rect.attributes.x) && x <= Number(rect.attributes.x) + Number(rect.attributes.width))).toBe(false)
      expect(x).toBeGreaterThanOrEqual(0)
      expect(x).toBeLessThanOrEqual(Number(svg.attributes.width))
    }
  })

  test('should route a forward edge over the grid when a box stands in its way', () => {
    const bypass = layoutOf({ ...SECOND_FLOW, edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'a', to: 'c', label: 'skips' }] })
    const svg = drawFlow(bypass)
    const routed = svg.withClass('edge').filter((edge) => edge.tag === 'path')
    const highest = Math.min(...svg.withTag('rect').map((rect) => Number(rect.attributes.y)))

    expect(routed).toHaveLength(1)
    expect(routed[0].attributes.class).toBe('edge')
    expect(laneOf(routed[0])).toBeLessThan(highest)
    expect(laneOf(routed[0])).toBeGreaterThan(0)
    expect(svg.withClass('edge').filter((edge) => edge.tag === 'line')).toHaveLength(2)
  })

  test('should say so when a label is cut, and keep the whole of it as the tip', () => {
    const label = 'Check that the account is active before sending any payment'
    const long = layoutOf({ ...SECOND_FLOW, nodes: [{ id: 'a', label, kind: 'decision' }], edges: [] })
    const node = drawFlow(long).withClass('node')[0]

    expect(node.children[1].textContent).toBe(label)
    expect(node.children.slice(3).map((piece) => piece.textContent)).toEqual(['Check that the', 'account is active\u2026'])
  })

  test('should wrap a label written without spaces by its width, not by its words', () => {
    const lines = wrapSvgText('コメントを投稿するとき、本文が空でないことを検証する', 20, 2)

    expect(lines).toEqual(['コメントを投稿すると', 'き、本文が空でない\u2026'])
    expect(wrapSvgText('a😀'.repeat(12), 20, 2).join('')).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/)
  })

  test('should join words by their width, so two wide words do not share a line they overflow', () => {
    expect(wrapSvgText('コメント投稿 本文検証', 20, 2)).toEqual(['コメント投稿', '本文検証'])
    expect(wrapSvgText('Comment posted', 20, 2)).toEqual(['Comment posted'])
  })

  test('should break a single word longer than a line instead of dropping its tail', () => {
    expect(wrapSvgText('CommentControllerStoreAction', 20, 2)).toEqual(['CommentControllerSto', 'reAction'])
  })

  test('should ask only the cells an edge passes over whether one blocks it', () => {
    let asked = 0
    const cells = new Proxy({}, { get: () => ((asked += 1), undefined) })

    const box = { x: 0, y: 0, w: 0, h: 0 }

    // Two columns apart in a flow of any width: the cost is the span.
    expect(flowBlocked([170, 28], [436, 28], cells, box, { ...box })).toBe(false)
    expect(asked).toBeLessThan(10)
  })

  test('should expose the node links to assistive technology', () => {
    expect(drawFlow(comment).attributes.role).toBe('group')
  })

  test('should leave no room for a lane in a flow with no cycle', () => {
    const straight = layoutOf({ ...FLOW, edges: FLOW.edges.slice(0, 3) })
    const rows = Math.max(...straight.nodes.map((node) => node.row)) + 1

    expect(Number(drawFlow(straight).attributes.height)).toBe(rows * FLOW_NODE_H + (rows - 1) * FLOW_GAP_Y)
  })

  test('should point one arrow head per drawn edge', () => {
    const svg = drawFlow(comment)

    expect(svg.withClass('arrow')).toHaveLength(svg.withClass('edge').length)
    expect(svg.withClass('arrow').every((head) => head.tag === 'polygon')).toBe(true)
  })

  test('should place two steps that declare one id apart', () => {
    const duplicated = layoutOf({ ...FLOW, nodes: [...FLOW.nodes, { id: 'reader', label: 'Again', kind: 'actor' }], edges: [] })
    const rects = drawFlow(duplicated).withTag('rect')
    const places = new Set(rects.map((rect) => `${rect.attributes.x},${rect.attributes.y}`))

    expect(places.size).toBe(8)
  })
})

describe('a flow whose strings are hostile', () => {
  function hostileFlows(payload: string): PlanDraft {
    return planWithFlows([
      {
        ...FLOW,
        title: payload,
        description: payload,
        nodes: FLOW.nodes.map((node) => ({ ...node, label: payload })),
        edges: FLOW.edges.map((edge) => ({ ...edge, label: payload })),
      },
    ])
  }

  test.each(PAYLOADS)('should round-trip %j through the data block', (payload) => {
    const plan = hostileFlows(payload)

    expect(payloadOf(plan).plan).toEqual(plan)
    expect(payloadOf(plan).flows[0].edges[0].label).toBe(payload)
  })

  test.each(PAYLOADS)('should leave no closing script tag for %j', (payload) => {
    const html = renderPlanHtml({ plan: hostileFlows(payload) })
    const closers = html.match(/<\/script/gi) ?? []

    expect(closers).toHaveLength(planTemplateSource().match(/<\/script/gi)?.length ?? 0)
    expect(html).not.toContain(' ')
  })

  test.each(PAYLOADS)('should draw %j as text and as nothing else', (payload) => {
    const svg = drawFlow(payloadOf(hostileFlows(payload)).flows[0])
    const tags = new Set(svg.all().map((node) => node.tag))
    const written = svg.all().filter((node) => node.textContent !== '')

    expect([...tags].sort()).toEqual(['a', 'g', 'line', 'path', 'polygon', 'rect', 'svg', 'text', 'title'])
    expect(written.every((node) => node.tag === 'text' || node.tag === 'title')).toBe(true)
    expect(written.filter((node) => node.attributes.class === 'edge-label').map((node) => node.textContent)).toEqual(
      Array.from({ length: 7 }, () => payload),
    )
    // The whole label is the tip; the box shows it wrapped on whitespace and cut to fit.
    const first = svg.withClass('node')[0]
    const pieces = first.children.filter((child) => child.attributes.class === 'title').map((piece) => piece.textContent)
    expect(first.children[1].textContent).toBe(payload)
    expect(pieces.length).toBeGreaterThan(0)
    for (const piece of pieces) {
      expect(piece.length).toBeGreaterThan(0)
      expect(payload.split(/\s+/).join(' ')).toContain(piece.replace(/\u2026$/, ''))
    }
  })
})

describe('the flow drawing in the page source', () => {
  /**
   * Every site that writes an `href`. The two anchors take `'#' + anchor`, where `anchor`
   * came out of `anchorId()`; the third is the export's blob URL. A fourth is a new way
   * for a plan string to become a link, so it has to be added here by hand.
   */
  test('should write an href in three places and no fourth', () => {
    const sites = script
      .split('\n')
      .filter((line) => /setAttribute\(\s*['"]href['"]|\.href\s*=[^=]|\bhref\s*:/.test(line))
      .map((line) => line.trim())

    expect(sites).toEqual([
      "node.setAttribute('href', '#' + anchor)",
      'anchor.href = url',
      "const a = svgEl('a', { href: '#' + anchor })",
    ])
  })

  // The line patterns above know three spellings. This one fails closed on any other:
  // a quoted key, `setAttributeNS`, `href.baseVal`, a call broken over two lines.
  test('should not spell href anywhere the three sites and their one comment do not', () => {
    expect(script.match(/href/gi)).toHaveLength(4)
    expect(script).not.toContain('setAttributeNS')
    expect(script).not.toContain('baseVal')
  })

  test('should take the flow anchor from the gate every other anchor goes through', () => {
    expect(functionSource('drawFlow')).toContain('const anchor = node.element && node.element in declared ? anchorId(node.element) : null')
  })

  /**
   * `svgEl(tag, attrs)` sets whatever keys it is handed, `href` included. Its callers
   * spell the tag as a string literal and the attributes as an object literal with no
   * computed key, so which attributes exist is decided by the page, never by a plan.
   */
  test('should call svgEl with a literal tag and literal attribute keys only', () => {
    const calls = [...script.matchAll(/(?<!function )svgEl\(/g)].map((match) => match.index + match[0].length)

    expect(calls.length).toBeGreaterThan(8)
    for (const at of calls) {
      const rest = script.slice(at)
      expect(rest).toMatch(/^'[a-z]+'(\)|, \{)/)
      if (!/^'[a-z]+', \{/.test(rest)) continue
      let depth = 0
      let end = rest.indexOf('{')
      for (; end < rest.length; end += 1) {
        if (rest[end] === '{') depth += 1
        else if (rest[end] === '}' && (depth -= 1) === 0) break
      }
      const literal = rest.slice(rest.indexOf('{'), end + 1)
      expect(literal).not.toMatch(/[{,]\s*\[/)
      expect(literal).not.toContain('...')
    }
  })

  test('should set an attribute by a computed name in svgEl and nowhere else', () => {
    const computed = script.split('\n').filter((line) => /setAttribute\(\s*[^'"\s]/.test(line))

    expect(computed.map((line) => line.trim())).toEqual(['node.setAttribute(key, String(attributes[key]))'])
  })

  test('should write flow text through svgText and by no other path', () => {
    const drawing = ['drawFlow', 'flowArrow', 'flowBox', 'flowBlocked', 'textUnits', 'fitPrefix', 'wrapSvgText']
      .map(functionSource)
      .join('\n')

    expect(drawing).not.toContain('textContent')
    expect(drawing).not.toMatch(/\bdocument\./)
    expect(drawing).not.toMatch(/\bel\(/)
    expect(functionSource('svgText')).toContain('node.textContent = text')
    expect(functionSource('svgTip')).toContain('node.textContent = text')
  })

  test('should draw each flow once, inside the card the filter and the checks key on', () => {
    const render = functionSource('renderFlows')

    expect(render.match(/drawFlow\(/g)).toHaveLength(1)
    expect(render).toContain('for (const flow of data.flows) {')
    expect(render).toContain('card({ id: flow.id, title: flow.title, change: change, body: body })')
    // `rename` carries `from` and `drop` a `reason`; the layout keeps the kind alone.
    expect(render).toContain('declared[flow.id]?.change ?? { kind: flow.change }')
  })

  test('should name the SVG namespace once, as a constant and not a request', () => {
    // Every URL the script spells, compared whole: a pattern naming the host would also
    // match `www.w3.org.evil.example`, and a count would not say which URL it counted.
    expect(script.match(/https?:\/\/[^\s'"`)]+/g)).toEqual(['http://www.w3.org/2000/svg'])
  })
})
