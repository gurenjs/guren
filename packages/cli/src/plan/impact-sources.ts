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
import { discoverControllerFiles, discoverPolicyFiles, discoverResourceFiles, discoverTestFiles, toPosixRelative } from '../discovery'
import { resolveInertiaPageFile } from '../inertia-pages'
import { readModelSources, type ModelSourceReading } from '../model-source-reading'
import type { ParseCache } from '../parse-cache'
import { readSourceClassIdentities } from '../source-class-identities'
import { scanTestRequests, testCoverage, type TestRequestScan, type UnresolvedTestRequest } from '../test-requests'
import { discoverSectionFiles } from './discovery'
import { classDetail, describeActions } from './app-detail'
import type { PlanAppNames } from './app-state'
import type { PlanImpactModel, PlanImpactReader, PlanImpactRoute, PlanImpactSources } from './impact'
import { isUnreadable, type PlanAppUnreadable } from './unreadable'

export interface PlanImpactSourcesInput {
  root: string
  /** Shared with the controller scan, so no controller is parsed twice. */
  cache: ParseCache
  /** Shared with detailed status; both views must describe the same model bytes. */
  modelReading?: Promise<ModelSourceReading>
  routes: ContextRoute[] | PlanAppUnreadable
  /** What `routes` was rendered from, in the same order, for `deriveAgentTools()`. */
  definitions: RouteDefinition[] | undefined
  /** Per route: the module whose registrar declared it, or `null`. */
  provenance: ReadonlyArray<string | null>
  /** Modules whose routes did not load, any of which may register ahead of a module's route. */
  moduleWarnings: readonly string[]
  controllers: ControllerMethodScan | PlanAppUnreadable
  /** The §2 sections, whose `unreadable` verdicts carry over. */
  sections: { models: PlanAppNames; resources: PlanAppNames; policies: PlanAppNames; pages: PlanAppNames; tests?: PlanAppUnreadable }
}

/** The tool each route name publishes, by the one derivation the runtime and codegen share. */
function toolNames(definitions: RouteDefinition[] | undefined): Map<string, string> {
  return new Map(deriveAgentTools(definitions ?? []).tools.map((tool) => [tool.routeName, tool.toolName]))
}

function impactRoutes(input: PlanImpactSourcesInput, requests: TestRequestScan): { routes: PlanImpactRoute[]; unresolved: UnresolvedTestRequest[] } {
  if (isUnreadable(input.routes)) return { routes: [], unresolved: requests.unresolved }
  const tools = toolNames(input.definitions)
  const routes = input.routes.map((route, index): PlanImpactRoute => {
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
  const coverage = testCoverage(requests, routes, { registered: { provenance: input.provenance, modulesIncomplete: input.moduleWarnings.length > 0 } })
  for (const [index, tests] of coverage.byRoute) routes[index]!.tests = tests
  for (const [index, tests] of coverage.uncertainByRoute) routes[index]!.uncertainTests = tests
  return { routes, unresolved: coverage.unresolved }
}

export async function loadPlanImpactSources(input: PlanImpactSourcesInput): Promise<PlanImpactSources> {
  const { root, sections } = input
  const relative = (file: string): string => toPosixRelative(root, file)
  const pageIds = isUnreadable(sections.pages) ? [] : sections.pages.map((page) => page.name)
  const [models, controllerDiscovery, resourceDiscovery, policyDiscovery, testDiscovery, pages] = await Promise.all([
    input.modelReading ?? readModelSources(root),
    discoverSectionFiles(root, discoverControllerFiles),
    discoverSectionFiles(root, (cwd) => readSourceClassIdentities(cwd, discoverResourceFiles)),
    classDetail(root, discoverPolicyFiles),
    discoverSectionFiles(root, discoverTestFiles),
    Promise.all(pageIds.map(async (id) => ({ id, file: await resolveInertiaPageFile(root, id) }))),
  ])

  const unreadable: Partial<Record<PlanImpactReader, string>> = {}
  const note = (reader: PlanImpactReader, section: readonly unknown[] | PlanAppUnreadable | ControllerMethodScan | undefined): void => {
    // A controller scan is an object, not a list, so `isUnreadable()` alone would take it for a failure.
    if (section !== undefined && !('methods' in section) && isUnreadable(section)) unreadable[reader] = section.unreadable
  }
  note('controllers', controllerDiscovery)
  note('resources', resourceDiscovery)
  note('tests', testDiscovery)
  note('policies', policyDiscovery)
  const controllerFiles = isUnreadable(controllerDiscovery) ? [] : controllerDiscovery
  const resourceIdentities = isUnreadable(resourceDiscovery) ? [] : resourceDiscovery
  const testFiles = isUnreadable(testDiscovery) ? [] : testDiscovery
  const policies = isUnreadable(policyDiscovery) ? [] : policyDiscovery
  note('models', sections.models)
  if (models.unreadable !== undefined) unreadable.models ??= models.unreadable
  note('resources', sections.resources)
  note('policies', sections.policies)
  note('pages', sections.pages)
  note('tests', sections.tests)
  note('routes', input.routes)
  note('controllers', input.controllers)

  const impactModels: PlanImpactModel[] = models.models.map(({ info, module, relPath }) => ({
    className: info.className, module, file: relPath, relationships: info.relationships,
  }))
  const reads = await scanColumnConsumers(
    root,
    {
      models: impactModels,
      controllers: controllerFiles.map(relative),
      resources: resourceIdentities.map(({ file }) => file),
      pages: pages.flatMap((page) => (page.file === undefined ? [] : [{ id: page.id, file: page.file }])),
    },
    input.cache,
  )

  // Directory listing order differs between file systems; sorted, Impact lists requests the same on each.
  const requests = await scanTestRequests(root, [...testFiles].sort(), input.cache)
  const routes = impactRoutes(input, requests)

  return {
    routes: routes.routes,
    models: impactModels,
    actions: 'methods' in input.controllers ? describeActions(root, input.controllers) : [],
    resources: reads.resources,
    policies,
    tests: testFiles.map(relative).sort(),
    testRequests: { unresolved: routes.unresolved, unparsed: requests.unparsed },
    reads,
    unreadable,
    unparsedModels: models.unparsedFiles,
    missingPages: pages.filter((page) => page.file === undefined).map((page) => page.id),
  }
}
