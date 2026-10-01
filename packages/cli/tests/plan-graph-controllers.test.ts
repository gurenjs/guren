import { expect, test } from 'bun:test'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { readControllerGraph } from '../src/application-graph-controllers'
import { parseControllerMethods, type ControllerMethodScan } from '../src/controller-methods'
import { formatTruncatedList, moduleNameFor } from '../src/discovery'
import { ParseCache, type ParseOutcome } from '../src/parse-cache'
import { loadPlanAppState, type PlanAppState } from '../src/plan/app-state'
import { planControllerSections } from '../src/plan/graph-controllers'
import { judgeFreshness, stampContextHash } from '../src/plan/freshness'
import { PlanDraftSchema } from '../src/plan/schema'
import { judgePlan } from '../src/plan/status'
import { validatePlan } from '../src/plan/validate'
import { createTempWorkspace, writeWorkspaceFiles } from './helpers'
import { loadCommentsPlan } from './plan-fixture'

/** RFC 0030's pre-convergence contract, retained to test approval and judgment parity. */
function legacySections(cwd: string, scan: ControllerMethodScan): Pick<PlanAppState, 'controllers' | 'actions'> {
  const skipped = [...scan.unreadableFiles, ...scan.unparsedFiles]
  if (skipped.length) {
    const unreadable = { unreadable: `${skipped.length} controller file(s) did not parse: ${formatTruncatedList(skipped)}` }
    return { controllers: unreadable, actions: unreadable }
  }
  const scope = (file: string) => moduleNameFor(cwd, resolve(cwd, file))
  return {
    controllers: [...scan.classFiles].map(([name, file]) => ({ name, module: scope(file) })),
    actions: [...scan.methods].map(([name, info]) => ({ name, module: scope(info.filePath) })),
  }
}

const files = {
  'app/Http/Controllers/Comments.ts': `
// This top-level throw must never run in either static reader.
throw new Error('The source was imported')
export class CommentController { store() {} destroy = async () => {} }
export { CommentController as Comments }
export default CommentController
`,
  'app/Http/Controllers/posts.v2.ts': 'export default class { ["send.now"]() {} }',
  'modules/billing/index.ts': 'export default {}',
  'modules/billing/app/Http/Controllers/Comments.ts': 'export class CommentController { store = () => {}; refund() {} }',
  'modules/sales/index.ts': 'export default {}',
  'modules/sales/app/Http/Controllers/Invoice.ts': 'export default class InvoiceController { index() {} }',
}

for (const [description, sources] of Object.entries({
  'empty application': {},
  'export aliases, class-field actions and same-named classes in modules': files,
  'a partially parsed controller tree': { ...files, 'app/Http/Controllers/Broken.ts': 'export class Broken {' },
})) {
  test(`Plan graph projection preserves checks and approval hashes: ${description}`, async () => {
    const workspace = await createTempWorkspace('guren-plan-graph-')
    try {
      await writeWorkspaceFiles(workspace.dir, sources)
      const legacy = legacySections(workspace.dir, await parseControllerMethods(workspace.dir))
      const current = await loadPlanAppState(workspace.dir, { detail: true, impact: true })
      const previous = { ...current, ...legacy }
      expect({ controllers: current.controllers, actions: current.actions }).toEqual(legacy)
      const plan = PlanDraftSchema.parse(loadCommentsPlan())
      const stamp = stampContextHash(plan, previous)
      expect(stampContextHash(plan, current)).toEqual(stamp)
      expect(validatePlan(plan, current)).toEqual(validatePlan(plan, previous))
      expect(judgePlan(plan, current)).toEqual(judgePlan(plan, previous))
      const approved = { ...plan, baseline: { rev: 'previous-release', contextHash: stamp.contextHash } }
      expect(judgeFreshness(approved, current)).toEqual(judgeFreshness(approved, previous))
    } finally { await workspace.cleanup() }
  })
}

test('retains each graph identity while the Plan view keeps its existing collision order', async () => {
  const workspace = await createTempWorkspace('guren-plan-graph-identity-')
  try {
    await writeWorkspaceFiles(workspace.dir, files)
    const reading = await readControllerGraph(workspace.dir, new ParseCache())
    const nodes = reading.nodes.filter((node) => node.label === 'CommentController')
    expect(nodes.map((node) => node.module)).toEqual([null, 'billing'])
    expect(new Set(nodes.map((node) => node.id)).size).toBe(2)
    const projected = planControllerSections(reading)
    expect(projected.classes).toContainEqual({ name: 'CommentController', module: 'billing' })
    // The old method map retains a root-only action even when a module replaces the class name.
    expect(projected.actions).toContainEqual({ name: 'CommentController.destroy', module: null })
    expect(projected.actions).toContainEqual({ name: 'CommentController.store', module: 'billing' })
  } finally { await workspace.cleanup() }
})

test('the shared reading honours captured sources and an unreadable cache result', async () => {
  const workspace = await createTempWorkspace('guren-plan-graph-cache-')
  try {
    await writeWorkspaceFiles(workspace.dir, { 'app/Http/Controllers/Post.ts': 'export class PostController { index() {} }' })
    const cache = new ParseCache()
    const file = resolve(workspace.dir, 'app/Http/Controllers/Post.ts')
    await cache.read(file)
    await writeFile(file, 'export class OtherController { show() {} }')
    const captured = await readControllerGraph(workspace.dir, cache)
    expect(captured.nodes[0]!.label).toBe('PostController')
    expect((await readControllerGraph(workspace.dir, new ParseCache())).nodes[0]!.label).toBe('OtherController')
    const unreadable = new class extends ParseCache { override async read(): Promise<ParseOutcome> { return { status: 'unreadable' } } }()
    const projection = planControllerSections(await readControllerGraph(workspace.dir, unreadable))
    expect(projection.classes).toEqual({ unreadable: '1 controller file(s) did not parse: app/Http/Controllers/Post.ts' })
    expect(projection.actions).toEqual(projection.classes)
  } finally { await workspace.cleanup() }
})

test('an unreadable controller directory remains unreadable rather than an empty collision-free section', async () => {
  const workspace = await createTempWorkspace('guren-plan-graph-directory-')
  try {
    await mkdir(resolve(workspace.dir, 'app/Http'), { recursive: true })
    await writeFile(resolve(workspace.dir, 'app/Http/Controllers'), 'not a directory')
    const state = await loadPlanAppState(workspace.dir)
    expect(state.controllers).toHaveProperty('unreadable')
    expect(state.actions).toEqual(state.controllers)
  } finally { await workspace.cleanup() }
})

for (const [description, validatorSource] of Object.entries({
  'schema aliases and default exports': `
throw new Error('A static validator reading imported the file')
const CommentPayload = {}
export { CommentPayload as CommentBodySchema }
export const CommentQuerySchema = {}
export default CommentPayload
`,
  'hidden star exports': "export * from '../../shared'",
  'malformed source': 'export const CommentBodySchema = {{{',
})) {
  test(`Validator graph projection preserves Plan approval facts: ${description}`, async () => {
    const workspace = await createTempWorkspace('guren-plan-graph-validator-')
    try {
      await writeWorkspaceFiles(workspace.dir, {
        'app/Http/Validators/Comment.ts': validatorSource,
        'modules/billing/index.ts': 'export default {}',
        'modules/billing/app/Http/Validators/Invoice.ts': 'export const InvoiceSchema = {}',
      })
      const { readValidatorExports } = await import('../src/plan/app-detail')
      const { readValidatorGraph } = await import('../src/application-graph-validators')
      const exports = await readValidatorExports(workspace.dir, new ParseCache())
      const reading = await readValidatorGraph(workspace.dir, new ParseCache())
      expect(reading.exports).toEqual(exports)
      const legacy = Array.isArray(exports) ? exports.flatMap(({ names, module }) => names.map((name) => ({ name, module })))
        .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0) : exports
      const current = await loadPlanAppState(workspace.dir)
      expect(current.validators).toEqual(legacy)
      const previous = { ...current, validators: legacy }
      const plan = PlanDraftSchema.parse(loadCommentsPlan())
      expect(stampContextHash(plan, current)).toEqual(stampContextHash(plan, previous))
      expect(validatePlan(plan, current)).toEqual(validatePlan(plan, previous))
      expect(judgePlan(plan, current)).toEqual(judgePlan(plan, previous))
      // Graph consumers may retain readable sections even when Plan requires a complete reading.
      const skipped: string[] = []
      const partial = await readValidatorGraph(workspace.dir, new ParseCache(), (file) => skipped.push(file))
      expect(partial.nodes).toContainEqual(expect.objectContaining({ kind: 'validator', label: 'InvoiceSchema', module: 'billing' }))
      expect(skipped.length).toBe(Array.isArray(exports) ? 0 : 1)
    } finally { await workspace.cleanup() }
  })
}
