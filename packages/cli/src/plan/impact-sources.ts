/**
 * What Impact (`impact.ts`) reads, built by `loadPlanAppState({ impact: true })` from the
 * scans the §2 checks already ran plus the column-consumer scan. Static throughout: it
 * imports no `db/schema.ts` and no validator file, which is why `plan:render` may ask for
 * it where it does not ask for `plan:status`'s detail. A reader that could not look is
 * named with its reason, never left as an empty list.
 */

import { deriveAgentTools, type RouteDefinition } from '@guren/server'

import { scanColumnConsumers } from '../column-consumers'
import type { ContextRoute } from '../context-route'
import type { ControllerMethodScan } from '../controller-methods'
import { discoverControllerFiles, discoverModelFiles, discoverPolicyFiles, discoverResourceFiles, discoverTestFiles, excludeBarrelFiles, toPosixRelative } from '../discovery'
import { resolveInertiaPageFile } from '../inertia-pages'
import { discoverParsedModels } from '../model-parser'
import type { ParseCache } from '../parse-cache'
import { classDetail, describeActions } from './app-detail'
import type { PlanAppNames } from './app-state'
import type { PlanImpactModel, PlanImpactReader, PlanImpactRoute, PlanImpactSources } from './impact'
import { isUnreadable, type PlanAppUnreadable } from './unreadable'

export interface PlanImpactSourcesInput {
  root: string
  /** Shared with the controller scan, so no controller is parsed twice. */
  cache: ParseCache
  routes: ContextRoute[] | PlanAppUnreadable
  /** What `routes` was rendered from, in the same order, for `deriveAgentTools()`. */
  definitions: RouteDefinition[] | undefined
  /** Per route: the module whose registrar declared it, or `null`. */
  provenance: ReadonlyArray<string | null>
  controllers: ControllerMethodScan | PlanAppUnreadable
  /** The §2 sections, whose `unreadable` verdicts carry over. */
  sections: { models: PlanAppNames; resources: PlanAppNames; policies: PlanAppNames; pages: PlanAppNames; tests?: PlanAppUnreadable }
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The tool each route name publishes, by the one derivation the runtime and codegen share. */
function toolNames(definitions: RouteDefinition[] | undefined): Map<string, string> {
  return new Map(deriveAgentTools(definitions ?? []).tools.map((tool) => [tool.routeName, tool.toolName]))
}

function impactRoutes(input: PlanImpactSourcesInput): PlanImpactRoute[] {
  if (isUnreadable(input.routes)) return []
  const tools = toolNames(input.definitions)
  return input.routes.map((route, index): PlanImpactRoute => {
    const toolName = route.name === undefined ? undefined : tools.get(route.name)
    return {
      ...(route.name !== undefined ? { name: route.name } : {}),
      method: route.method,
      path: route.path,
      ...(route.controller ? { action: `${route.controller.name}.${route.controller.action}` } : {}),
      bindings: route.bindings ?? {},
      module: input.provenance[index] ?? null,
      ...(toolName !== undefined ? { toolName } : {}),
    }
  })
}

interface ModelRead {
  models: PlanImpactModel[]
  unparsed: string[]
  unreadable?: string
}

/** Parsed models, and the model files that yielded no class: a model missing for that reason is not absent. */
async function impactModels(root: string): Promise<ModelRead> {
  try {
    const [parsed, files] = await Promise.all([discoverParsedModels(root), discoverModelFiles(root)])
    const models = parsed.map(({ info, module, relPath }) => ({ className: info.className, module, file: relPath, relationships: info.relationships }))
    const seen = new Set(models.map((model) => model.file))
    const unparsed = excludeBarrelFiles(files).map((file) => toPosixRelative(root, file)).filter((file) => !seen.has(file))
    return { models, unparsed }
  } catch (error) {
    return { models: [], unparsed: [], unreadable: reasonOf(error) }
  }
}

export async function loadPlanImpactSources(input: PlanImpactSourcesInput): Promise<PlanImpactSources> {
  const { root, sections } = input
  const relative = (file: string): string => toPosixRelative(root, file)
  const pageIds = isUnreadable(sections.pages) ? [] : sections.pages.map((page) => page.name)
  const [models, controllerFiles, resourceFiles, policies, testFiles, pages] = await Promise.all([
    impactModels(root),
    discoverControllerFiles(root),
    discoverResourceFiles(root),
    classDetail(root, discoverPolicyFiles),
    discoverTestFiles(root),
    Promise.all(pageIds.map(async (id) => ({ id, file: await resolveInertiaPageFile(root, id) }))),
  ])

  const unreadable: Partial<Record<PlanImpactReader, string>> = {}
  const note = (reader: PlanImpactReader, section: readonly unknown[] | PlanAppUnreadable | ControllerMethodScan | undefined): void => {
    // A controller scan is an object, not a list, so `isUnreadable()` alone would take it for a failure.
    if (section !== undefined && !('methods' in section) && isUnreadable(section)) unreadable[reader] = section.unreadable
  }
  note('models', sections.models)
  if (models.unreadable !== undefined) unreadable.models = models.unreadable
  note('resources', sections.resources)
  note('policies', sections.policies)
  note('pages', sections.pages)
  note('tests', sections.tests)
  note('routes', input.routes)
  note('controllers', input.controllers)

  const reads = await scanColumnConsumers(
    root,
    {
      models: models.models,
      controllers: controllerFiles.map(relative),
      resources: excludeBarrelFiles(resourceFiles).map(relative),
      pages: pages.flatMap((page) => (page.file === undefined ? [] : [{ id: page.id, file: page.file }])),
    },
    input.cache,
  )

  return {
    routes: impactRoutes(input),
    models: models.models,
    actions: 'methods' in input.controllers ? describeActions(root, input.controllers) : [],
    resources: reads.resources,
    policies,
    tests: testFiles.map(relative).sort(),
    reads,
    unreadable,
    unparsedModels: models.unparsed,
    missingPages: pages.filter((page) => page.file === undefined).map((page) => page.id),
  }
}
