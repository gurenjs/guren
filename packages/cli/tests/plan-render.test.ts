import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { planDiagram } from '../src/plan/diagram'
import {
  buildPlanPayload,
  escapeJsonForScript,
  planBreakingChanges,
  planLinks,
  planTemplatePath,
  renderPlanHtml,
} from '../src/plan/render'
import { PlanDraftSchema, PlanSchema, type PlanDraft } from '../src/plan/schema'
import { parsePlanDocument, planOutputPath, renderPlanFile } from '../src/plan-render'

function loadFixture(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(import.meta.dir, 'fixtures/plan/comments.plan.json'), 'utf8'))
}

function draft(): PlanDraft {
  return PlanDraftSchema.parse(loadFixture())
}

/**
 * The page's data block, taken out of the rendered document the way a consumer
 * would. Asserting on this string rather than on the whole file is what lets the
 * escaping tests fail: the document's own script and style are full of `<` and `&`.
 */
function dataBlock(html: string): string {
  const opening = '<script type="application/json" id="plan-data">'
  const start = html.indexOf(opening)
  expect(start).toBeGreaterThan(-1)
  const end = html.indexOf('</script>', start)
  expect(end).toBeGreaterThan(start)
  return html.slice(start + opening.length, end)
}

/**
 * A plan whose every free-text field carries one hostile string, parsed the way the
 * command parses one: a payload the schema would reject reaches no user either.
 */
function hostilePlan(payload: string): PlanDraft {
  const fixture = draft()
  return PlanDraftSchema.parse({
    ...fixture,
    title: payload,
    summary: payload,
    scope: { goals: [payload], nonGoals: [payload] },
    assumptions: [payload],
    hints: [payload],
    questions: fixture.questions.map((question) => ({
      ...question,
      question: payload,
      options: question.options.map(() => ({ label: payload, consequence: payload })),
      assumed: payload,
    })),
    models: fixture.models.map((model) => ({ ...model, fillable: [payload] })),
    views: fixture.views.map((view) => ({
      ...view,
      purpose: payload,
      actions: view.actions.map((action) => ({ ...action, label: payload })),
      states: { empty: payload, error: payload, loading: payload },
    })),
    controllers: fixture.controllers.map((controller) => ({
      ...controller,
      actions: controller.actions.map((action) => ({ ...action, rules: [payload] })),
    })),
    tasks: fixture.tasks.map((task) => ({
      ...task,
      summary: payload,
      acceptance: task.acceptance.map((acceptance) => ({ ...acceptance, description: payload, given: [payload] })),
    })),
  })
}

const PAYLOADS = [
  '</script><script>alert(1)</script>',
  '<!--',
  '<img src=x onerror=alert(1)>',
  'javascript:alert(1)',
  'line\u2028separator\u2029paragraph',
  'dollars: $` and $& and $\' and $0',
  ']]>',
  '&lt;&amp;&gt;',
]

describe('renderPlanHtml', () => {
  test('should embed the payload so that it parses back to the plan it was given', () => {
    const plan = draft()

    const embedded = JSON.parse(dataBlock(renderPlanHtml({ plan })))

    expect(embedded.plan).toEqual(plan)
  })

  test('should round-trip a plan whose strings are hostile', () => {
    for (const payload of PAYLOADS) {
      const plan = hostilePlan(payload)

      const embedded = JSON.parse(dataBlock(renderPlanHtml({ plan })))

      expect(embedded.plan).toEqual(plan)
    }
  })

  test('should write no raw markup character into the data block', () => {
    for (const payload of PAYLOADS) {
      const block = dataBlock(renderPlanHtml({ plan: hostilePlan(payload) }))

      expect(block).not.toContain('<')
      expect(block).not.toContain('>')
      expect(block).not.toContain('&')
      expect(block).not.toContain('\u2028')
      expect(block).not.toContain('\u2029')
    }
  })

  test('should leave no closing script tag anywhere in the document', () => {
    const html = renderPlanHtml({ plan: hostilePlan('</script ><script>alert(1)</script>') })

    // The template's own two closing tags, and no third from the plan.
    expect(html.match(/<\/script/g)).toHaveLength(2)
  })

  test('should not expand a replacement pattern the plan spells', () => {
    const payload = 'before $` middle $& after $\''

    const embedded = JSON.parse(dataBlock(renderPlanHtml({ plan: hostilePlan(payload) })))

    expect(embedded.plan.title).toBe(payload)
  })

  test('should render a draft with no plan hash', () => {
    const embedded = JSON.parse(dataBlock(renderPlanHtml({ plan: draft() })))

    expect(embedded.planHash).toBeNull()
  })

  test('should render the plan hash once the plan carries a baseline', () => {
    const plan = PlanSchema.parse({ ...loadFixture(), baseline: { rev: 'abc123', contextHash: {} } })

    const embedded = JSON.parse(dataBlock(renderPlanHtml({ plan })))

    expect(embedded.planHash).toMatch(/^[0-9a-f]{64}$/)
  })

  test('should render nothing for an absent status', () => {
    const embedded = JSON.parse(dataBlock(renderPlanHtml({ plan: draft() })))

    expect(embedded.status).toBeNull()
  })

  test('should carry check results that name the element they concern', () => {
    const checks = [
      {
        key: 'plan-route-action',
        title: 'Route action',
        status: 'fail' as const,
        message: 'route.comments.store names no action',
        elementId: 'route.comments.store',
      },
    ]

    const embedded = JSON.parse(dataBlock(renderPlanHtml({ plan: draft(), checks })))

    expect(embedded.checks).toEqual(checks)
  })

  test('should carry no checks when none are given', () => {
    const embedded = JSON.parse(dataBlock(renderPlanHtml({ plan: draft() })))

    expect(embedded.checks).toEqual([])
  })
})

describe('escapeJsonForScript', () => {
  test('should escape every character that could close the block or break a line', () => {
    expect(escapeJsonForScript('"</a>&\u2028\u2029"')).toBe('"\\u003c/a\\u003e\\u0026\\u2028\\u2029"')
  })

  test('should leave the value JSON.parse reads back unchanged', () => {
    const value = { text: '</script><!-- & \u2028' }

    expect(JSON.parse(escapeJsonForScript(JSON.stringify(value)))).toEqual(value)
  })
})

describe('the plan template', () => {
  const source = readFileSync(planTemplatePath(), 'utf8')

  test.each([
    'innerHTML',
    'outerHTML',
    'insertAdjacentHTML',
    'document.write',
    'eval(',
    'new Function',
    'createContextualFragment',
    'srcdoc',
  ])('should use no %s sink', (sink) => {
    expect(source).not.toContain(sink)
  })

  test('should declare a content security policy that allows no network origin', () => {
    expect(source).toContain('http-equiv="Content-Security-Policy"')
    expect(source).toContain("default-src 'none'")
  })

  test('should load nothing over the network', () => {
    expect(source).not.toMatch(/(src|href)\s*=\s*["']https?:/)
    expect(source).not.toContain('fetch(')
    expect(source).not.toContain('XMLHttpRequest')
    expect(source).not.toContain('cdn')
  })

  test('should carry the data placeholder exactly once', () => {
    expect(source.match(/__GUREN_PLAN_DATA__/g)).toHaveLength(1)
  })

  test('should resolve from the directory the published package ships', () => {
    const manifest = JSON.parse(readFileSync(join(import.meta.dir, '../package.json'), 'utf8'))

    expect(planTemplatePath()).toBe(join(import.meta.dir, '..', 'templates', 'plan', 'index.html'))
    expect(manifest.files).toContain('templates')
  })
})

describe('planLinks', () => {
  test('should link a route to its action and an action to its validator', () => {
    const links = planLinks(draft())

    expect(links).toContainEqual({ from: 'route.comments.store', to: 'action.comments.store', label: 'action' })
    expect(links).toContainEqual({ from: 'action.comments.store', to: 'validator.comment', label: 'body' })
  })

  test('should link a view form to the route it submits to', () => {
    const links = planLinks(draft())

    expect(links).toContainEqual({ from: 'view.posts.show', to: 'route.comments.store', label: 'submits to' })
  })

  test('should drop a reference to an id the plan does not declare', () => {
    const plan = draft()
    plan.routes[0].action = 'action.nowhere'

    expect(planLinks(plan).some((link) => link.to === 'action.nowhere')).toBe(false)
  })
})

describe('planDiagram', () => {
  test('should draw one table per model with its columns', () => {
    const diagram = planDiagram(draft())

    expect(diagram.tables.map((table) => table.table)).toEqual(['posts', 'comments'])
    expect(diagram.tables[1].columns.map((column) => column.name)).toEqual(['id', 'body', 'postId', 'createdAt'])
  })

  test('should draw a foreign key as an edge between the two models', () => {
    const diagram = planDiagram(draft())

    expect(diagram.edges).toContainEqual({
      id: 'fk:column.comment.postId',
      from: 'model.comment',
      to: 'model.post',
      label: 'postId',
      kind: 'foreignKey',
    })
  })

  test('should not draw a relationship that mirrors a foreign key twice', () => {
    const diagram = planDiagram(draft())

    expect(diagram.edges.filter((edge) => edge.kind === 'relationship')).toEqual([])
  })

  test('should skip a foreign key to a model the plan does not declare', () => {
    const plan = draft()
    plan.models = plan.models.filter((model) => model.id !== 'model.post')

    const diagram = planDiagram(plan)

    expect(diagram.edges).toEqual([])
    expect(diagram.tables[0].columns.find((column) => column.name === 'postId')?.referencesModel).toBe('model.post')
  })
})

describe('planBreakingChanges', () => {
  test('should find nothing breaking in an additive plan', () => {
    expect(planBreakingChanges(draft())).toEqual([])
  })

  test('should flag a dropped column', () => {
    const plan = draft()
    plan.models[1].columns[1].change = { kind: 'drop', reason: 'unused' }

    expect(planBreakingChanges(plan)).toContainEqual({
      elementId: 'column.comment.body',
      section: 'columns',
      title: 'comments.body',
      reason: 'The column is dropped.',
    })
  })

  test('should flag a renamed route', () => {
    const plan = draft()
    plan.routes[0].change = { kind: 'rename', from: 'comments.create' }

    expect(planBreakingChanges(plan).map((item) => item.elementId)).toContain('route.comments.store')
  })

  test('should flag an altered route that publishes an agent tool', () => {
    const plan = draft()
    plan.routes[0].change = { kind: 'alter' }
    plan.routes[0].agent = { toolName: 'comments_store', readOnly: false }

    expect(planBreakingChanges(plan).map((item) => item.reason)).toContain(
      'The published agent tool comments_store changes.',
    )
  })
})

describe('buildPlanPayload', () => {
  test('should attribute an element to the entity whose task covers it', () => {
    const payload = buildPlanPayload({ plan: draft() })

    const route = payload.elements.find((element) => element.id === 'route.comments.store')
    expect(route?.entity).toBe('Comment')
    expect(payload.entities).toEqual(['Comment'])
  })

  test('should attribute a column to its model', () => {
    const payload = buildPlanPayload({ plan: draft() })

    expect(payload.elements.find((element) => element.id === 'column.comment.body')?.entity).toBe('Comment')
  })

  test('should list every element the plan declares', () => {
    const payload = buildPlanPayload({ plan: draft() })

    expect(payload.elements.map((element) => element.id)).toContain('AC-comments-1')
    expect(payload.elements.map((element) => element.id)).toContain('Q-delete')
  })
})

describe('renderPlanFile', () => {
  async function fixtureDir(document: unknown): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'guren-plan-render-'))
    await writeFile(join(dir, 'comments.plan.json'), JSON.stringify(document), 'utf8')
    return dir
  }

  test('should write the page beside the plan', async () => {
    const dir = await fixtureDir(loadFixture())

    const result = await renderPlanFile(join(dir, 'comments.plan.json'))

    expect(result.path).toBe(join(dir, 'comments.plan.html'))
    expect(await readFile(result.path, 'utf8')).toContain('plan-data')
  })

  test('should write to the path -o names', async () => {
    const dir = await fixtureDir(loadFixture())

    const result = await renderPlanFile(join(dir, 'comments.plan.json'), { output: join(dir, 'review.html') })

    expect(result.path).toBe(join(dir, 'review.html'))
  })

  test('should resolve a relative output against the working directory it is given', async () => {
    const dir = await fixtureDir(loadFixture())

    const result = await renderPlanFile(join(dir, 'comments.plan.json'), { output: 'review.html', cwd: dir })

    expect(result.path).toBe(join(dir, 'review.html'))
  })

  test('should report a schema failure with the path that failed', async () => {
    const dir = await fixtureDir({ ...loadFixture(), title: 42 })

    await expect(renderPlanFile(join(dir, 'comments.plan.json'))).rejects.toThrow(/title/)
  })

  test('should report a file that is not JSON', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'guren-plan-render-'))
    await writeFile(join(dir, 'comments.plan.json'), 'not json', 'utf8')

    await expect(renderPlanFile(join(dir, 'comments.plan.json'))).rejects.toThrow(/not valid JSON/)
  })

  test('should report a plan that is not there', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'guren-plan-render-'))

    await expect(renderPlanFile(join(dir, 'missing.plan.json'))).rejects.toThrow(/Cannot read the plan/)
  })

  test('should name every id the plan declares twice', async () => {
    const fixture = loadFixture()
    const models = fixture.models as Array<{ id: string }>
    models[1].id = models[0].id
    const dir = await fixtureDir(fixture)

    const result = await renderPlanFile(join(dir, 'comments.plan.json'))

    expect(result.duplicateIds).toEqual(['model.post'])
  })
})

describe('parsePlanDocument', () => {
  test('should accept a draft that carries no baseline', () => {
    expect(parsePlanDocument(loadFixture())).toMatchObject({ title: 'Comments on posts' })
  })

  test('should hold a document with a baseline to the full plan schema', () => {
    expect(() => parsePlanDocument({ ...loadFixture(), baseline: { rev: '' } })).toThrow(/baseline/)
  })
})

describe('planOutputPath', () => {
  test('should replace a .json extension', () => {
    expect(planOutputPath('/tmp/comments.plan.json')).toBe('/tmp/comments.plan.html')
  })

  test('should append to a path with no .json extension', () => {
    expect(planOutputPath('/tmp/plan')).toBe('/tmp/plan.html')
  })
})
