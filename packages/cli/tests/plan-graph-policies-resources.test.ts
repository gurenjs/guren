import { expect, test } from 'bun:test'
import { resolve } from 'node:path'

import { graphId, type GraphNode } from '../src/application-graph'
import { loadApplicationGraph } from '../src/application-graph-load'
import { scanColumnConsumers } from '../src/column-consumers'
import { classNameFromPath, discoverPolicyFiles, discoverResourceFiles, excludeBarrelFiles, moduleNameFor, toPosixRelative } from '../src/discovery'
import { ParseCache } from '../src/parse-cache'
import { readSourceClassIdentities, type SourceClassIdentity } from '../src/source-class-identities'
import { classDetail } from '../src/plan/app-detail'
import { loadPlanAppState, type PlanAppNames } from '../src/plan/app-state'
import { discoverSectionFiles } from '../src/plan/discovery'
import { judgeFreshness, stampContextHash } from '../src/plan/freshness'
import { readPolicyAbilities } from '../src/plan/policy-abilities'
import { PlanDraftSchema } from '../src/plan/schema'
import { judgePlan } from '../src/plan/status'
import { isUnreadable, type PlanAppUnreadable } from '../src/plan/unreadable'
import { validatePlan } from '../src/plan/validate'
import { createTempWorkspace, writeWorkspaceFiles } from './helpers'
import { loadCommentsPlan } from './plan-fixture'

/** RFC 0030's filename identity contract, independent of the shared projection. */
async function legacyIdentities(cwd: string, discover: (root: string) => Promise<string[]>): Promise<SourceClassIdentity[] | PlanAppUnreadable> {
  const files = await discoverSectionFiles(cwd, discover)
  if (isUnreadable(files)) return files
  return excludeBarrelFiles(files).map((file) => ({ className: classNameFromPath(file), module: moduleNameFor(cwd, file), file: toPosixRelative(cwd, file) }))
}

function legacyNames(identities: SourceClassIdentity[] | PlanAppUnreadable): PlanAppNames {
  return isUnreadable(identities) ? identities : identities.map(({ className, module }) => ({ name: className, module }))
    .sort((a, b) => a.name === b.name ? 0 : a.name < b.name ? -1 : 1)
}

const sources = {
  'app/Models/Post.ts': 'export class Post {}',
  'app/Policies/CommentPolicy.ts': "throw new Error('Policy was imported'); export default class DifferentName { delete() {} }",
  'app/Policies/InvoicePolicy.mts': "import { definePolicy as define } from '@guren/core'; export const InvoicePolicy = define({ view: () => true })",
  'app/Policies/OtherPolicy.mjs': 'export class UnexpectedName { view() {} }',
  'app/Policies/CommentPolicy.js': 'export class CommentPolicy { update() {} }',
  'app/Policies/index.ts': 'export class IgnoredBarrel {}',
  'app/Policies/.Hidden.ts': 'export class Hidden {}',
  'app/Policies/Ignored.d.ts': 'export declare class Ignored {}',
  'app/Policies/CommentPolicy.test.ts': 'export class Test {}',
  'app/Http/Resources/CommentResource.ts': "throw new Error('Resource was imported'); import type { Post } from '../../Models/Post'; export class DifferentName { toArray(post: Post) { return { title: post.title } } }",
  'app/Http/Resources/CommentResource.js': 'export class CommentResource { toArray() { return { body: this.body } } }',
  'app/Http/Resources/posts.v2.mts': 'export default class { toArray() { return {} } }',
  'app/Http/Resources/index.ts': 'export class IgnoredBarrel {}',
  'app/Http/Resources/.Hidden.ts': 'export class Hidden {}',
  'app/Http/Resources/Ignored.d.ts': 'export declare class Ignored {}',
  'app/Http/Resources/CommentResource.test.ts': 'export class Test {}',
  'modules/billing/index.ts': 'export default {}',
  'modules/billing/app/Policies/CommentPolicy.ts': 'export class CommentPolicy { delete = () => true }',
  'modules/billing/app/Http/Resources/CommentResource.ts': 'export class CommentResource { toArray() { return {} } }',
}

const scenarios: Record<string, Record<string, string>> = {
  'empty app': {},
  'filename aliases, default classes, modules, barrels, source twins and excluded files': sources,
  'malformed sources retain their existence names': {
    ...sources, 'app/Policies/CommentPolicy.ts': 'export class {', 'app/Http/Resources/CommentResource.ts': 'export class {',
  },
  'unreadable policy directory': { 'app/Policies': 'not a directory' },
  'unreadable resource directory': { 'app/Http/Resources': 'not a directory' },
  'unreadable modules directory': { modules: 'not a directory' },
}

for (const [description, files] of Object.entries(scenarios)) {
  test(`Policy/Resource shared identities preserve checks, status, approval facts and Impact: ${description}`, async () => {
    const workspace = await createTempWorkspace('guren-plan-policy-resource-')
    try {
      await writeWorkspaceFiles(workspace.dir, files)
      const [resources, policies] = await Promise.all([
        legacyIdentities(workspace.dir, discoverResourceFiles), legacyIdentities(workspace.dir, discoverPolicyFiles),
      ])
      const current = await loadPlanAppState(workspace.dir, { detail: true, impact: true })
      const legacy = { resources: legacyNames(resources), policies: legacyNames(policies) }
      expect({ resources: current.resources, policies: current.policies }).toEqual(legacy)
      expect(current.detail!.resources).toEqual(resources)
      expect(current.impact!.policies).toEqual(isUnreadable(policies) ? [] : policies)
      const cache = new ParseCache()
      const policyDetails = isUnreadable(policies) ? policies : await Promise.all(policies.map(async (policy) => {
        const parsed = await cache.get(resolve(workspace.dir, policy.file))
        return { ...policy, abilities: parsed ? readPolicyAbilities(parsed.ast, policy.className) : { unreadable: `${policy.file} could not be parsed` } }
      }))
      expect(current.detail!.policies).toEqual(policyDetails)
      const resourceFiles = isUnreadable(resources) ? [] : resources.map(({ file }) => file)
      const consumed = await scanColumnConsumers(workspace.dir, { models: current.impact!.models, controllers: [], pages: [], resources: resourceFiles }, cache)
      expect(current.impact!.resources).toEqual(consumed.resources)
      if (isUnreadable(resources)) expect(current.impact!.unreadable!.resources).toBe(resources.unreadable)
      if (isUnreadable(policies)) expect(current.impact!.unreadable!.policies).toBe(policies.unreadable)
      const previous = { ...current, ...legacy, detail: { ...current.detail!, resources, policies: policyDetails } }
      const rootPlan = PlanDraftSchema.parse(loadCommentsPlan())
      const modulePlan = PlanDraftSchema.parse({ ...rootPlan,
        resources: rootPlan.resources.map((resource) => ({ ...resource, module: 'billing' })),
        policies: rootPlan.policies.map((policy) => ({ ...policy, module: 'billing' })),
      })
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

for (const malformed of [false, true]) {
  test(`Policy graph retains identities, support failures and source-twin order (${malformed ? 'malformed' : 'readable'})`, async () => {
    const workspace = await createTempWorkspace('guren-graph-policy-parity-')
    try {
      await writeWorkspaceFiles(workspace.dir, { ...sources, ...(malformed ? { 'app/Policies/CommentPolicy.ts': 'export class {' } : {}) })
      const nodes: GraphNode[] = []
      const failures: Array<{ code: string; file: string }> = []
      const seen = new Set<string>()
      const cache = new ParseCache()
      for (const absolute of excludeBarrelFiles(await discoverPolicyFiles(workspace.dir))) {
        const file = toPosixRelative(workspace.dir, absolute)
        const className = classNameFromPath(absolute)
        const parsed = await cache.get(absolute)
        const abilities = parsed ? readPolicyAbilities(parsed.ast, className) : undefined
        if (!abilities || 'unreadable' in abilities) { failures.push({ code: 'unparsed-or-unsupported', file }); continue }
        const key = absolute.replace(/\.(?:ts|mts|js|mjs)$/, '')
        if (seen.has(key)) { failures.push({ code: 'source-twin', file }); continue }
        seen.add(key)
        nodes.push({ id: graphId('policy', file, className), kind: 'policy', label: className,
          module: moduleNameFor(workspace.dir, absolute), file, evidence: [{ kind: 'static', source: 'source', file }] })
      }
      const graph = await loadApplicationGraph({ cwd: workspace.dir, introspect: false })
      expect(graph.nodes.filter((node) => node.kind === 'policy')).toEqual(nodes.sort((a, b) => a.id.localeCompare(b.id)))
      const order = (a: { code: string; file?: string }, b: { code: string; file?: string }) => JSON.stringify(a).localeCompare(JSON.stringify(b))
      expect(graph.coverage.policy!.reasons.map(({ code, file }) => ({ code, file })).sort(order)).toEqual(failures.sort(order))
      expect(graph.coverage.policy!.status).toBe(failures.length ? 'partial' : 'complete')
    } finally { await workspace.cleanup() }
  })
}

test('identity metadata preserves discovery order and never substitutes source-declared names', async () => {
  const workspace = await createTempWorkspace('guren-source-identities-')
  try {
    const files = ['modules/billing/app/Policies/SamePolicy.mts', 'app/Policies/SamePolicy.js', 'app/Policies/SamePolicy.ts', 'app/Policies/index.ts']
    const identities = await readSourceClassIdentities(workspace.dir, async () => files.map((file) => resolve(workspace.dir, file)))
    expect(identities).toEqual([
      { className: 'SamePolicy', module: 'billing', file: files[0]! },
      { className: 'SamePolicy', module: null, file: files[1]! },
      { className: 'SamePolicy', module: null, file: files[2]! },
    ])
    expect(await classDetail(workspace.dir, async () => files.map((file) => resolve(workspace.dir, file)))).toEqual(identities)
    await expect(readSourceClassIdentities(workspace.dir, async () => { throw new Error('discovery failed') })).rejects.toThrow('discovery failed')
  } finally { await workspace.cleanup() }
})
