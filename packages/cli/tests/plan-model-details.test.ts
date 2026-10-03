import { expect, test } from 'bun:test'
import { chmod, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { loadApplicationGraph } from '../src/application-graph-load'
import { parseControllerMethods } from '../src/controller-methods'
import { discoverModelFiles, excludeBarrelFiles, toPosixRelative } from '../src/discovery'
import { discoverParsedModels } from '../src/model-parser'
import { readModelSources, type ModelSourceReading } from '../src/model-source-reading'
import { ParseCache } from '../src/parse-cache'
import { loadPlanAppDetail, type PlanAppDetailInput } from '../src/plan/app-detail'
import { isUnreadable, loadPlanAppState, type PlanAppState } from '../src/plan/app-state'
import { judgeFreshness, stampContextHash } from '../src/plan/freshness'
import { planImpact } from '../src/plan/impact'
import { loadPlanImpactSources, type PlanImpactSourcesInput } from '../src/plan/impact-sources'
import { PlanDraftSchema } from '../src/plan/schema'
import { judgePlan } from '../src/plan/status'
import { validatePlan } from '../src/plan/validate'
import { createTempWorkspace, writeWorkspaceFiles } from './helpers'
import { loadCommentsPlan } from './plan-fixture'

/** RFC 0030's independent source reading, for detailed-status and Impact verdict parity. */
async function legacyReading(root: string): Promise<ModelSourceReading> {
  try {
    const [models, files] = await Promise.all([discoverParsedModels(root), discoverModelFiles(root)])
    const seen = new Set(models.map(({ relPath }) => relPath))
    return { models, unparsedFiles: excludeBarrelFiles(files).map((file) => toPosixRelative(root, file)).filter((file) => !seen.has(file)) }
  } catch (error) {
    return { models: [], unparsedFiles: [], unreadable: error instanceof Error ? error.message : String(error) }
  }
}

const post = `throw new Error('Model metadata must never execute application code')
export class Post extends defineModel(posts) {
  static fillable = ['title', 'body']
  static relationTypes: { comments: HasManyRecord<CommentRecord> }
}
Post.hasMany('comments', () => Comment, 'postId')`
const fixtures: Record<string, Record<string, string>> = {
  'absent models': {},
  'root/module collisions, literal and dynamic fillable, and relationships': {
    'app/Models/Post.ts': post,
    'app/Http/Controllers/PostController.ts': `import { Post } from '../../Models/Post'
      export class PostController { async show() { const post = await Post.firstOrFail(); return this.json({ title: post.title }) } }`,
    'app/Models/Comment.ts': `export class Comment extends defineModel(comments, { fillable: ['body'] }) {
      static relationTypes: { post: BelongsToRecord<PostRecord> }
    }`,
    'modules/billing/app/Models/Post.ts': `export class Post extends defineModel(billingPosts) {
      static fillable = buildFields()
      static { this.belongsTo('owner', () => User, 'userId') }
    }`,
  },
  'first declared class, anonymous defaults, malformed sources and barrels': {
    'app/Models/Two.ts': 'class First extends defineModel(first) {}\nexport class Second extends defineModel(second) {}',
    'app/Models/Anonymous.ts': 'export default class {}\nexport class Named {}',
    'app/Models/Broken.ts': 'export class Broken {',
    'app/Models/index.ts': 'export { Post } from "./Post"',
    'app/Models/index-extra.ts': 'export class BarrelModel extends defineModel(barrels) {}',
    'app/Models/Post.test.ts': 'export class TestOnly {}',
  },
  'malformed root model directory': { 'app/Models': 'not a directory' },
  'malformed module model directory': { 'app/Models/Post.ts': post, 'modules/billing/app/Models': 'not a directory' },
  'malformed modules directory': { 'app/Models/Post.ts': post, modules: 'not a directory' },
}

for (const [description, files] of Object.entries(fixtures)) {
  test(`shared Model reading preserves Plan status, Impact and approval facts: ${description}`, async () => {
    const workspace = await createTempWorkspace('guren-plan-model-details-')
    try {
      await writeWorkspaceFiles(workspace.dir, files)
      const legacy = await legacyReading(workspace.dir)
      expect(await readModelSources(workspace.dir)).toEqual(legacy)
      const graph = await loadApplicationGraph({ cwd: workspace.dir, introspect: false })
      const current = await loadPlanAppState(workspace.dir, { detail: true, impact: true })
      const detailModels = isUnreadable(current.models) ? current.models : legacy.unreadable !== undefined ? { unreadable: legacy.unreadable } :
        legacy.models.map(({ info, module, relPath }) => ({ className: info.className, module, file: relPath, table: info.tableName, relationships: info.relationships, fillable: info.fillable }))
      const detailUnparsed = isUnreadable(current.models) || legacy.unreadable !== undefined ? [] : legacy.unparsedFiles
      const impactModels = legacy.models.map(({ info, module, relPath }) => ({ className: info.className, module, file: relPath, relationships: info.relationships }))
      expect(current.detail!.models).toEqual(detailModels)
      expect(current.detail!.unparsedModelFiles).toEqual(detailUnparsed)
      expect(current.impact!.models).toEqual(impactModels)
      expect(current.impact!.unparsedModels).toEqual(legacy.unparsedFiles)
      expect(current.impact!.unreadable.models).toBe(isUnreadable(current.models) ? current.models.unreadable : legacy.unreadable)
      if (description.startsWith('root/module')) expect(current.impact!.reads.reads).toContainEqual(expect.objectContaining({ property: 'title', kind: 'controller' }))
      const previous: PlanAppState = { ...current,
        detail: { ...current.detail!, models: detailModels, unparsedModelFiles: detailUnparsed },
        impact: { ...current.impact!, models: impactModels, unparsedModels: legacy.unparsedFiles },
      }
      const plan = PlanDraftSchema.parse(loadCommentsPlan())
      expect(validatePlan(plan, current)).toEqual(validatePlan(plan, previous))
      expect(judgePlan(plan, current)).toEqual(judgePlan(plan, previous))
      expect(planImpact(plan, current.impact!)).toEqual(planImpact(plan, previous.impact!))
      const stamp = stampContextHash(plan, previous)
      expect(stampContextHash(plan, current)).toEqual(stamp)
      const approved = { ...plan, baseline: { rev: 'previous-release', contextHash: stamp.contextHash } }
      expect(judgeFreshness(approved, current)).toEqual(judgeFreshness(approved, previous))
      expect((await loadApplicationGraph({ cwd: workspace.dir, introspect: false })).snapshot.id).toBe(graph.snapshot.id)
      expect((await loadPlanAppState(workspace.dir, { detail: true })).detail).toEqual(current.detail)
      expect((await loadPlanAppState(workspace.dir, { impact: true })).impact).toEqual(current.impact)
      if (!isUnreadable(current.detail!.models)) {
        for (const [index, model] of current.detail!.models.entries()) expect(model.relationships === current.impact!.models[index]!.relationships).toBe(true)
        expect(current.detail!.unparsedModelFiles).toBe(current.impact!.unparsedModels)
      }
    } finally { await workspace.cleanup() }
  }, 30_000)
}

async function consumerInputs(root: string): Promise<{ detail: PlanAppDetailInput; impact: PlanImpactSourcesInput }> {
  const state = await loadPlanAppState(root)
  const controllers = await parseControllerMethods(root)
  const common = { root, routes: [], definitions: undefined, provenance: [], moduleWarnings: [], controllers }
  return {
    detail: { ...common, routesFile: undefined, pages: [], models: undefined, validators: [] },
    impact: { ...common, cache: new ParseCache(), sections: { models: state.models, resources: [], policies: [], pages: [] } },
  }
}

test('shared Model reading keeps both consumers on the same bytes and standalone reads see edits', async () => {
  const workspace = await createTempWorkspace('guren-plan-model-refresh-')
  try {
    await writeWorkspaceFiles(workspace.dir, { 'app/Models/Post.ts': post })
    const inputs = await consumerInputs(workspace.dir)
    const modelReading = Promise.resolve(await readModelSources(workspace.dir))
    await writeFile(resolve(workspace.dir, 'app/Models/Post.ts'), 'export class Post extends defineModel(updatedPosts) { static fillable = [] }')
    const detail = await loadPlanAppDetail({ ...inputs.detail, modelReading })
    const impact = await loadPlanImpactSources({ ...inputs.impact, modelReading })
    expect(detail.models).toMatchObject([{ table: 'posts', fillable: ['title', 'body'] }])
    expect(impact.models[0]!.relationships).toEqual([{ name: 'comments', type: 'hasMany', relatedModel: 'Comment' }])
    expect((await loadPlanAppDetail(inputs.detail)).models).toMatchObject([{ table: 'updatedPosts', fillable: [], relationships: [] }])
    expect((await loadPlanImpactSources(inputs.impact)).models[0]!.relationships).toEqual([])
    const fresh = await loadPlanAppState(workspace.dir, { detail: true, impact: true })
    expect(fresh.detail!.models).toMatchObject([{ table: 'updatedPosts', fillable: [] }])
    expect(fresh.impact!.models[0]!.relationships).toEqual([])
  } finally { await workspace.cleanup() }
})

test('a message-less Model read failure remains unreadable for both consumers', async () => {
  const workspace = await createTempWorkspace('guren-plan-model-failure-')
  try {
    const inputs = await consumerInputs(workspace.dir)
    const modelReading = Promise.resolve<ModelSourceReading>({ models: [], unparsedFiles: [], unreadable: '' })
    expect((await loadPlanAppDetail({ ...inputs.detail, modelReading })).models).toEqual({ unreadable: '' })
    const impact = await loadPlanImpactSources({ ...inputs.impact, modelReading })
    expect(impact.unreadable.models).toBe('')
    expect(impact.models).toEqual([])
  } finally { await workspace.cleanup() }
})

test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('an unreadable Model file invalidates the source reading without discarding its failure reason', async () => {
  const workspace = await createTempWorkspace('guren-plan-model-permissions-')
  const file = resolve(workspace.dir, 'app/Models/Post.ts')
  try {
    await writeWorkspaceFiles(workspace.dir, { 'app/Models/Post.ts': post })
    await chmod(file, 0)
    const legacy = await legacyReading(workspace.dir)
    expect(legacy.unreadable).toBeDefined()
    expect(await readModelSources(workspace.dir)).toEqual(legacy)
    const current = await loadPlanAppState(workspace.dir, { detail: true, impact: true })
    expect(current.detail!.models).toHaveProperty('unreadable')
    expect(current.impact!.unreadable.models).toBeDefined()
    expect(current.impact!.models).toEqual([])
  } finally { await chmod(file, 0o600); await workspace.cleanup() }
})
