import { expect, test } from 'bun:test'
import { mkdir, writeFile } from 'node:fs/promises'
import { extname, relative, resolve } from 'node:path'

import { graphId } from '../src/application-graph'
import { loadApplicationGraph } from '../src/application-graph-load'
import { readModelGraph } from '../src/application-graph-models'
import { readPageGraph } from '../src/application-graph-pages'
import { collectFiles, discoverModelFiles, moduleNameFor } from '../src/discovery'
import { PAGE_COMPONENT_EXTENSIONS } from '../src/inertia-pages'
import { parseModelFile } from '../src/model-parser'
import { ParseCache, type ParseOutcome } from '../src/parse-cache'
import { loadPlanAppState, type PlanAppState } from '../src/plan/app-state'
import { discoverSectionFiles } from '../src/plan/discovery'
import { judgeFreshness, stampContextHash } from '../src/plan/freshness'
import { planModelSection, planPageSection } from '../src/plan/graph-models-pages'
import { PlanDraftSchema } from '../src/plan/schema'
import { judgePlan } from '../src/plan/status'
import { isUnreadable } from '../src/plan/unreadable'
import { validatePlan } from '../src/plan/validate'
import { createTempWorkspace, writeWorkspaceFiles } from './helpers'
import { loadCommentsPlan } from './plan-fixture'

/** RFC 0030's pre-convergence identity projection, retained for approval and verdict parity. */
async function legacySections(cwd: string): Promise<Pick<PlanAppState, 'models' | 'pages'>> {
  const files = await discoverSectionFiles(cwd, discoverModelFiles)
  const models = isUnreadable(files) ? files : (await Promise.all(files.map(async (file) => ({ file, info: await parseModelFile(file) }))))
    .flatMap(({ file, info }) => info ? [{ name: info.className, module: moduleNameFor(cwd, file) }] : [])
    .sort((a, b) => a.name.localeCompare(b.name))
  const pagesDir = resolve(cwd, 'resources/js/pages')
  const pages = await discoverSectionFiles(cwd, async () => (await collectFiles(pagesDir, PAGE_COMPONENT_EXTENSIONS))
    .map((file) => {
      const path = relative(pagesDir, file).split(/[\\/]/).join('/')
      return path.slice(0, path.length - extname(path).length)
    }).filter((id) => !id.startsWith('contracts')).sort())
  return { models, pages: isUnreadable(pages) ? pages : pages.map((name) => ({ name, module: null })) }
}

const sources = {
  'app/Models/Post.ts': "throw new Error('Static reader imported a model'); class Post {} export class Extra {}",
  'app/Models/Comment.ts': 'class Comment {} export { Comment as Discussion }',
  'app/Models/Anonymous.ts': 'export default class {}\nexport class Later {}',
  'app/Models/HelperFirst.mts': 'class Helper {} export default class Actual {}',
  'app/Models/Empty.mjs': 'export const table = {}',
  'app/Models/.hidden.ts': 'export class Invisible {}',
  'app/Models/Types.d.ts': 'export declare class Invisible {}',
  'modules/billing/index.ts': 'export default {}',
  'modules/billing/app/Models/Post.ts': 'export default class Post {}',
  'modules/billing/app/Models/Invoice.js': 'export class Invoice {}',
  'resources/js/pages/posts/Show.tsx': "throw new Error('Static reader imported a page'); export default () => <div />",
  'resources/js/pages/posts/Show.jsx': 'export default () => <div />',
  'resources/js/pages/billing/invoices/Show.tsx': 'export default () => <div />',
  'resources/js/pages/contracts/Shared.tsx': 'export default () => <div />',
  'resources/js/pages/contracts-old.tsx': 'export default () => <div />',
  'resources/js/pages/posts/Ignore.ts': 'export const notAPage = true',
  'resources/js/pages/.Hidden.tsx': 'export default () => <div />',
}

const scenarios: Record<string, Record<string, string>> = {
  'empty app': {},
  'multiple classes, aliases, anonymous defaults, modules and duplicate page IDs': sources,
  'syntax errors retain page existence and omit malformed models': {
    ...sources, 'app/Models/Post.ts': 'export class Post {', 'resources/js/pages/posts/Show.tsx': 'export default ( =>',
  },
  'models directory cannot open': { 'app/Models': 'not a directory' },
  'pages directory cannot open': { 'resources/js/pages': 'not a directory' },
  'modules directory cannot open': { modules: 'not a directory' },
}

for (const [description, files] of Object.entries(scenarios)) {
  test(`Model/Page convergence preserves Plan checks, status and approval facts: ${description}`, async () => {
    const workspace = await createTempWorkspace('guren-plan-graph-models-pages-')
    try {
      await writeWorkspaceFiles(workspace.dir, files)
      const legacy = await legacySections(workspace.dir)
      const current = await loadPlanAppState(workspace.dir, { detail: true, impact: true })
      expect({ models: current.models, pages: current.pages }).toEqual(legacy)
      const previous = { ...current, ...legacy }
      const rootPlan = PlanDraftSchema.parse(loadCommentsPlan())
      const modulePlan = PlanDraftSchema.parse({ ...rootPlan, models: rootPlan.models.map((model) => ({ ...model, module: 'billing' })) })
      for (const plan of [rootPlan, modulePlan]) {
        const stamp = stampContextHash(plan, previous)
        expect(stampContextHash(plan, current)).toEqual(stamp)
        expect(validatePlan(plan, current)).toEqual(validatePlan(plan, previous))
        expect(judgePlan(plan, current)).toEqual(judgePlan(plan, previous))
        const approved = { ...plan, baseline: { rev: 'previous-release', contextHash: stamp.contextHash } }
        expect(judgeFreshness(approved, current)).toEqual(judgeFreshness(approved, previous))
      }
    } finally { await workspace.cleanup() }
  })
}

test('graph retains every class and page file while Plan keeps its first-class and page-prefix rules', async () => {
  const workspace = await createTempWorkspace('guren-plan-graph-identities-')
  try {
    await writeWorkspaceFiles(workspace.dir, sources)
    const cache = new ParseCache()
    const models = await readModelGraph(workspace.dir, cache)
    expect(models.nodes).toContainEqual(expect.objectContaining({ label: 'Extra', module: null }))
    expect(models.nodes).toContainEqual(expect.objectContaining({ label: 'Later', module: null }))
    expect(models.nodes.filter((node) => node.label === 'Post').map((node) => node.module)).toEqual([null, 'billing'])
    expect(models.nodes.find((node) => node.label === 'Post')!.id).toBe(graphId('model', 'app/Models/Post.ts', 'Post'))
    const names = planModelSection(models)
    expect(names).toContainEqual({ name: 'Helper', module: null })
    expect(names).not.toContainEqual({ name: 'Actual', module: null })
    expect(names).not.toContainEqual({ name: 'Later', module: null })
    const pages = await readPageGraph(workspace.dir, cache)
    const twins = pages.nodes.filter((node) => node.label === 'posts/Show')
    expect(twins).toHaveLength(2)
    expect(twins[0]!.id).not.toBe(twins[1]!.id)
    expect(pages.nodes.some((node) => node.label === 'contracts/Shared')).toBe(true)
    expect(planPageSection(pages)).toEqual([
      { name: 'billing/invoices/Show', module: null }, { name: 'posts/Show', module: null }, { name: 'posts/Show', module: null },
    ])
    const graph = await loadApplicationGraph({ cwd: workspace.dir, introspect: false })
    expect(graph.nodes.filter((node) => node.kind === 'model')).toEqual([...models.nodes].sort((a, b) => a.id.localeCompare(b.id)))
    expect(graph.nodes.filter((node) => node.kind === 'page')).toEqual([...pages.nodes].sort((a, b) => a.id.localeCompare(b.id)))
  } finally { await workspace.cleanup() }
})

test('shared Model/Page readers use captured sources and expose partial graph coverage', async () => {
  const workspace = await createTempWorkspace('guren-plan-graph-captured-')
  try {
    await writeWorkspaceFiles(workspace.dir, { 'app/Models/Post.ts': 'class Post {}', 'resources/js/pages/posts/Show.tsx': 'export default () => <div />' })
    const cache = new ParseCache()
    const model = resolve(workspace.dir, 'app/Models/Post.ts')
    const page = resolve(workspace.dir, 'resources/js/pages/posts/Show.tsx')
    await Promise.all([cache.read(model), cache.read(page)])
    await writeFile(model, 'class Changed {}')
    await writeFile(page, 'export default ( =>')
    expect(planModelSection(await readModelGraph(workspace.dir, cache))).toEqual([{ name: 'Post', module: null }])
    expect((await readPageGraph(workspace.dir, cache)).nodes).toHaveLength(1)
    expect(planModelSection(await readModelGraph(workspace.dir, new ParseCache()))).toEqual([{ name: 'Changed', module: null }])
    const freshPages = await readPageGraph(workspace.dir, new ParseCache())
    expect(freshPages.nodes).toEqual([])
    expect(planPageSection(freshPages)).toEqual([{ name: 'posts/Show', module: null }])
    const graph = await loadApplicationGraph({ cwd: workspace.dir, introspect: false })
    expect(graph.coverage.page!.reasons).toContainEqual(expect.objectContaining({ code: 'unparsed-or-unreadable', file: 'resources/js/pages/posts/Show.tsx' }))
  } finally { await workspace.cleanup() }
})

test('an unreadable model source cannot produce an empty collision-free Plan section', async () => {
  const workspace = await createTempWorkspace('guren-plan-graph-unreadable-')
  try {
    await writeWorkspaceFiles(workspace.dir, { 'app/Models/Post.ts': 'class Post {}' })
    const unreadable = new class extends ParseCache { override async read(): Promise<ParseOutcome> { return { status: 'unreadable' } } }()
    const reading = await readModelGraph(workspace.dir, unreadable)
    expect(reading.nodes).toEqual([])
    expect(reading.unsupportedFiles).toEqual(['app/Models/Post.ts'])
    expect(planModelSection(reading)).toEqual({ unreadable: '1 model file(s) could not be read: app/Models/Post.ts' })
    const state = await loadPlanAppState(workspace.dir)
    const plan = PlanDraftSchema.parse(loadCommentsPlan())
    const blocked = { ...state, models: planModelSection(reading) }
    expect(stampContextHash(plan, blocked).unstamped).toContainEqual(expect.objectContaining({ id: 'model.post' }))
  } finally { await workspace.cleanup() }
})

test('nested unreadable directories preserve Plan diagnostics and graph partial coverage', async () => {
  const workspace = await createTempWorkspace('guren-plan-graph-directory-')
  try {
    await mkdir(resolve(workspace.dir, 'app'), { recursive: true })
    await writeFile(resolve(workspace.dir, 'app/Models'), 'not a directory')
    const graph = await loadApplicationGraph({ cwd: workspace.dir, introspect: false })
    expect(graph.coverage.model!.reasons).toContainEqual(expect.objectContaining({ code: 'unreadable-directory', file: 'app/Models' }))
    expect((await loadPlanAppState(workspace.dir)).models).toHaveProperty('unreadable')
  } finally { await workspace.cleanup() }
})
