/**
 * What Impact (`impact.ts`) reads, built by `loadPlanAppState({ impact: true })` from the
 * scans the §2 checks already ran plus the column-consumer scan. Static throughout: it
 * imports no `db/schema.ts` and no validator file, which is why `plan:render` may ask for
 * it where it does not ask for `plan:status`'s detail.
 */

import { resolve } from 'node:path'

import { scanColumnConsumers } from '../column-consumers'
import type { ContextRoute } from '../context-route'
import type { ControllerMethodScan } from '../controller-methods'
import {
  classNameFromPath,
  discoverControllerFiles,
  discoverPolicyFiles,
  discoverResourceFiles,
  discoverTestFiles,
  excludeBarrelFiles,
  moduleNameFor,
  toPosixRelative,
} from '../discovery'
import { resolveInertiaPageFile } from '../inertia-pages'
import { discoverParsedModels } from '../model-parser'
import { ParseCache } from '../parse-cache'
import { describeActions } from './app-detail'
import type { PlanAppUnreadable } from './app-state'
import type { PlanImpactModel, PlanImpactRoute, PlanImpactSources } from './impact'

export interface PlanImpactSourcesInput {
  root: string
  routes: ContextRoute[] | PlanAppUnreadable
  controllers: ControllerMethodScan | PlanAppUnreadable
  /** Page ids, or why the pages directory would not open. */
  pages: string[] | PlanAppUnreadable
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function impactRoutes(routes: ContextRoute[] | PlanAppUnreadable): PlanImpactSources['routes'] {
  if (!Array.isArray(routes)) return routes
  return routes.map((route): PlanImpactRoute => {
    // `deriveAgentTools()`'s identity: `agent.toolName` when given, otherwise the route name.
    const toolName = route.agent ? (route.agent.toolName ?? route.name) : undefined
    return {
      ...(route.name !== undefined ? { name: route.name } : {}),
      method: route.method,
      path: route.path,
      ...(route.controller ? { action: `${route.controller.name}.${route.controller.action}` } : {}),
      bindings: route.bindings ?? {},
      ...(toolName !== undefined ? { toolName } : {}),
    }
  })
}

async function impactModels(root: string): Promise<{ models: PlanImpactModel[] | PlanAppUnreadable; files: Array<{ className: string; file: string }> }> {
  try {
    const parsed = await discoverParsedModels(root)
    const models = parsed.map(({ info, module, relPath }) => ({ className: info.className, module, file: relPath, relationships: info.relationships }))
    return { models, files: models.map(({ className, file }) => ({ className, file })) }
  } catch (error) {
    return { models: { unreadable: reasonOf(error) }, files: [] }
  }
}

export async function loadPlanImpactSources(input: PlanImpactSourcesInput): Promise<PlanImpactSources> {
  const { root } = input
  const relative = (file: string): string => toPosixRelative(root, file)
  const [models, controllerFiles, resourceFiles, policyFiles, testFiles, pages] = await Promise.all([
    impactModels(root),
    discoverControllerFiles(root).catch((): string[] => []),
    discoverResourceFiles(root).catch((): string[] => []),
    discoverPolicyFiles(root).catch((): string[] => []),
    discoverTestFiles(root).catch((): string[] => []),
    Array.isArray(input.pages)
      ? Promise.all(input.pages.map(async (id) => ({ id, file: await resolveInertiaPageFile(root, id) })))
      : Promise.resolve([]),
  ])

  const reads = await scanColumnConsumers(
    root,
    {
      models: models.files,
      controllers: controllerFiles.map(relative),
      resources: excludeBarrelFiles(resourceFiles).map(relative),
      pages: pages.flatMap((page) => (page.file === undefined ? [] : [{ id: page.id, file: page.file }])),
    },
    new ParseCache(),
  )
  if (!Array.isArray(input.pages)) reads.unreadable.push(`resources/js/pages (${input.pages.unreadable})`)

  return {
    routes: impactRoutes(input.routes),
    models: models.models,
    actions: 'methods' in input.controllers ? describeActions(root, input.controllers) : input.controllers,
    resources: reads.resources,
    policies: excludeBarrelFiles(policyFiles).map((file) => ({
      className: classNameFromPath(file),
      module: moduleNameFor(root, resolve(root, file)),
      file: relative(file),
    })),
    tests: testFiles.map(relative).sort(),
    reads,
  }
}
