import { expect, test } from 'bun:test'
import { chmod, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { loadApplicationGraph } from '../src/application-graph-load'
import { parseControllerMethods } from '../src/controller-methods'
import { describeInertiaPagePropKeys, resolveInertiaPageFile } from '../src/inertia-pages'
import { readPageSources, type PageSourceReading } from '../src/page-source-reading'
import { ParseCache } from '../src/parse-cache'
import { loadPlanAppDetail, type PlanAppDetailInput, type PlanAppPageDetail } from '../src/plan/app-detail'
import { appNames, isUnreadable, loadPlanAppState, type PlanAppState } from '../src/plan/app-state'
import { judgeFreshness, stampContextHash } from '../src/plan/freshness'
import { planImpact } from '../src/plan/impact'
import { loadPlanImpactSources, type PlanImpactSourcesInput } from '../src/plan/impact-sources'
import { PlanDraftSchema } from '../src/plan/schema'
import { judgePlan } from '../src/plan/status'
import { validatePlan } from '../src/plan/validate'
import { createTempWorkspace, writeWorkspaceFiles } from './helpers'
import { loadCommentsPlan } from './plan-fixture'

/** RFC 0030's independent file and Props selection, retained for approval/status parity. */
async function legacyDetail(root: string, ids: readonly string[]): Promise<PlanAppPageDetail[]> {
  return Promise.all(ids.map(async (id) => {
    const file = await resolveInertiaPageFile(root, id)
    return { id, ...(file === undefined ? {} : { file }),
      props: (await describeInertiaPagePropKeys(root, id)) ?? { status: 'unreadable' as const, reason: 'the page has no component file' },
    }
  }))
}

const show = `throw new Error('Pages must not be imported for metadata')
import type { PostRecord } from '../../../../app/Models/Post'
interface Props { post: PostRecord; title?: string }
export default function Show({ post }: Props) { return <p>{post.title}</p> }`
const fixtures: Record<string, Record<string, string>> = {
  'absent pages': {},
  'nested paths, duplicate extensions and excluded contracts prefixes': {
    'app/Models/Post.ts': 'export class Post extends defineModel(posts) {}',
    'resources/js/pages/posts/Show.tsx': show,
    'resources/js/pages/posts/Show.jsx': 'export default () => <p>fallback</p>',
    'resources/js/pages/contracts/Hidden.tsx': show,
    'resources/js/pages/contractsExtra.tsx': show,
  },
  'aliases, extended and generic Props, undeclared Props and malformed sources': {
    'resources/js/pages/Alias.tsx': 'interface Local { title: string }; type Props = Local; export default () => <p />',
    'resources/js/pages/Extended.tsx': 'interface Props extends Imported { title: string }; export default () => <p />',
    'resources/js/pages/Generic.tsx': 'interface Props<T> { item: T }; export default () => <p />',
    'resources/js/pages/Undeclared.jsx': 'export default () => <p />',
    'resources/js/pages/Broken.tsx': 'export default function Broken( {',
  },
  'malformed page directory': { 'resources/js/pages': 'not a directory' },
  'malformed modules directory': { modules: 'not a directory', 'resources/js/pages/posts/Show.tsx': show },
}

for (const [description, files] of Object.entries(fixtures)) {
  test(`shared Page selection preserves status, Impact and approval facts: ${description}`, async () => {
    const workspace = await createTempWorkspace('guren-plan-page-details-')
    try {
      await writeWorkspaceFiles(workspace.dir, files)
      const graph = await loadApplicationGraph({ cwd: workspace.dir, introspect: false })
      const current = await loadPlanAppState(workspace.dir, { detail: true, impact: true })
      const ids = isUnreadable(current.pages) ? [] : appNames(current.pages)
      const sources = await Promise.all(ids.map(async (id) => ({ id, file: await resolveInertiaPageFile(workspace.dir, id) })))
      expect(await readPageSources(workspace.dir, ids)).toEqual(sources)
      const detailPages = isUnreadable(current.pages) ? current.pages : await legacyDetail(workspace.dir, ids)
      expect(current.detail!.pages).toEqual(detailPages)
      const missingPages = sources.filter(({ file }) => file === undefined).map(({ id }) => id)
      expect(current.impact!.missingPages).toEqual(missingPages)
      if (description.startsWith('nested')) {
        expect(ids).toEqual(['posts/Show', 'posts/Show'])
        expect(sources.every(({ file }) => file === 'resources/js/pages/posts/Show.tsx')).toBe(true)
        expect(current.impact!.reads.reads).toContainEqual(expect.objectContaining({ kind: 'page', property: 'title', file: 'resources/js/pages/posts/Show.tsx' }))
      }
      const previous: PlanAppState = { ...current,
        detail: { ...current.detail!, pages: detailPages },
        impact: { ...current.impact!, missingPages },
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
    } finally { await workspace.cleanup() }
  }, 30_000)
}

async function consumerInputs(root: string, ids: string[]): Promise<{ detail: PlanAppDetailInput; impact: PlanImpactSourcesInput }> {
  const state = await loadPlanAppState(root)
  const controllers = await parseControllerMethods(root)
  const common = { root, routes: [], definitions: undefined, provenance: [], moduleWarnings: [], controllers }
  return {
    detail: { ...common, routesFile: undefined, pages: ids, models: undefined, validators: [] },
    impact: { ...common, cache: new ParseCache(), sections: { models: state.models, resources: [], policies: [], pages: ids.map((name) => ({ name, module: null })) } },
  }
}

test('missing Page IDs and duplicates retain detailed diagnostics and Impact missing-page entries', async () => {
  const workspace = await createTempWorkspace('guren-plan-page-missing-')
  try {
    const ids = ['Missing', 'Missing']
    const inputs = await consumerInputs(workspace.dir, ids)
    const detail = await loadPlanAppDetail(inputs.detail)
    expect(detail.pages).toEqual(await legacyDetail(workspace.dir, ids))
    expect((await loadPlanImpactSources(inputs.impact)).missingPages).toEqual(ids)
  } finally { await workspace.cleanup() }
})

test('shared Page selection is retained when a higher-priority component appears; a new invocation sees it', async () => {
  const workspace = await createTempWorkspace('guren-plan-page-refresh-')
  try {
    await writeWorkspaceFiles(workspace.dir, { 'resources/js/pages/Show.jsx': 'export default () => <p />' })
    const inputs = await consumerInputs(workspace.dir, ['Show'])
    const pageReading = Promise.resolve(await readPageSources(workspace.dir, ['Show']))
    await writeFile(resolve(workspace.dir, 'resources/js/pages/Show.tsx'), 'interface Props { fresh: string }; export default () => <p />')
    expect((await loadPlanAppDetail({ ...inputs.detail, pageReading })).pages).toEqual([{ id: 'Show', file: 'resources/js/pages/Show.jsx', props: { status: 'undeclared' } }])
    expect((await loadPlanImpactSources({ ...inputs.impact, pageReading })).missingPages).toEqual([])
    expect((await loadPlanAppDetail(inputs.detail)).pages).toMatchObject([{ file: 'resources/js/pages/Show.tsx', props: { status: 'keys', keys: [{ name: 'fresh' }] } }])
    expect((await readPageSources(workspace.dir, ['Show']))[0]!.file).toBe('resources/js/pages/Show.tsx')
  } finally { await workspace.cleanup() }
})

test('a selected component that disappears is unreadable rather than silently replaced by its JSX twin', async () => {
  const workspace = await createTempWorkspace('guren-plan-page-removed-')
  try {
    await writeWorkspaceFiles(workspace.dir, { 'resources/js/pages/Show.tsx': show, 'resources/js/pages/Show.jsx': 'export default () => <p />' })
    const inputs = await consumerInputs(workspace.dir, ['Show'])
    const pageReading = Promise.resolve(await readPageSources(workspace.dir, ['Show']))
    await rm(resolve(workspace.dir, 'resources/js/pages/Show.tsx'))
    expect((await loadPlanAppDetail({ ...inputs.detail, pageReading })).pages).toMatchObject([{ file: 'resources/js/pages/Show.tsx', props: { status: 'unreadable', reason: expect.stringContaining('ENOENT') } }])
    const impact = await loadPlanImpactSources({ ...inputs.impact, pageReading })
    expect(impact.missingPages).toEqual([])
    expect(impact.reads.unreadable).toContain('resources/js/pages/Show.tsx')
    expect((await loadPlanAppDetail(inputs.detail)).pages).toMatchObject([{ file: 'resources/js/pages/Show.jsx', props: { status: 'undeclared' } }])
  } finally { await workspace.cleanup() }
})

test('unavailable Page sections retain their verdict and do not consume a supplied file list', async () => {
  const workspace = await createTempWorkspace('guren-plan-page-unavailable-')
  try {
    const inputs = await consumerInputs(workspace.dir, [])
    const unreadable = { unreadable: 'pages could not be listed' }
    const pageReading = Promise.resolve<PageSourceReading[]>([{ id: 'Missing', file: undefined }])
    expect((await loadPlanAppDetail({ ...inputs.detail, pages: unreadable, pageReading })).pages).toEqual(unreadable)
    const impact = await loadPlanImpactSources({ ...inputs.impact, sections: { ...inputs.impact.sections, pages: unreadable }, pageReading })
    expect(impact.unreadable.pages).toBe(unreadable.unreadable)
    expect(impact.missingPages).toEqual([])
  } finally { await workspace.cleanup() }
})

test('Page resolution errors propagate through both consumers rather than becoming missing-file results', async () => {
  const workspace = await createTempWorkspace('guren-plan-page-resolution-')
  try {
    const inputs = await consumerInputs(workspace.dir, ['Show'])
    await writeWorkspaceFiles(workspace.dir, { 'resources/js/pages': 'not a directory' })
    await expect(readPageSources(workspace.dir, ['Show'])).rejects.toThrow()
    await expect(loadPlanAppDetail(inputs.detail)).rejects.toThrow()
    await expect(loadPlanImpactSources(inputs.impact)).rejects.toThrow()
  } finally { await workspace.cleanup() }
})

test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('an unreadable selected TSX component keeps its file identity and Props failure instead of choosing JSX', async () => {
  const workspace = await createTempWorkspace('guren-plan-page-permissions-')
  const file = resolve(workspace.dir, 'resources/js/pages/Show.tsx')
  try {
    await writeWorkspaceFiles(workspace.dir, { 'resources/js/pages/Show.tsx': show, 'resources/js/pages/Show.jsx': 'export default () => <p />' })
    const inputs = await consumerInputs(workspace.dir, ['Show'])
    await chmod(file, 0)
    expect((await loadPlanAppDetail(inputs.detail)).pages).toEqual(await legacyDetail(workspace.dir, ['Show']))
    expect((await readPageSources(workspace.dir, ['Show']))[0]!.file).toBe('resources/js/pages/Show.tsx')
    const impact = await loadPlanImpactSources({ ...inputs.impact, cache: new ParseCache() })
    expect(impact.missingPages).toEqual([])
    expect(impact.reads.unreadable).toContain('resources/js/pages/Show.tsx')
  } finally { await chmod(file, 0o600); await workspace.cleanup() }
})
