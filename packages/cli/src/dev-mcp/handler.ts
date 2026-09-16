import { generateAgentTypes } from '../agents-types'
import { generateApiClientTypes } from '../api-client-types'
import { generateChannelTypes } from '../channel-types'
import { runCheck } from '../check'
import { renderContextMarkdown } from '../context'
import { generateDataTypes } from '../data-types'
import { runDoctor, suggestNextSteps } from '../doctor'
import { buildDocsGraphReport, renderDocsGraphMarkdown } from '../docs-graph'
import { renderEntityContextMarkdown } from '../entity-context'
import { createFreshContextApi } from '../fresh-context'
import { runGate } from '../gate'
import { generateGuidelines } from '../guidelines'
import { makeController } from '../make-controller'
import { makeFeature } from '../make-feature'
import { makeModel } from '../make-model'
import { makeTest } from '../make-test'
import { makeView } from '../make-view'
import { listModels } from '../model-list'
import { generatePageTypes } from '../pages-types'
import { generateRouteTypes } from '../routes-types'
import type { DevMcpApi } from './server'

export interface DevMcpHandler {
  fetch(request: Request): Promise<Response>
  close(): Promise<void>
}

export interface CreateDevMcpHandlerOptions {
  cwd: string
  version?: string
  /** Stands in for the project on disk; defaults to this package's own functions. */
  api?: DevMcpApi
}

/**
 * Bun cannot evict an ES module, so in a long-running dev server the route loading
 * would answer every request from the module graph captured at the first one.
 * Route-dependent context generation therefore runs in a child process;
 * `guren_codegen` still runs in-process, and Vite's routeTypesPlugin repairs it.
 */
function defaultApi(): DevMcpApi {
  return {
    renderContextMarkdown,
    renderEntityContextMarkdown,
    runCheck,
    runGate,
    listModels,
    generateGuidelines,
    runDoctor,
    suggestNextSteps,
    makeFeature,
    makeController,
    makeModel,
    makeView,
    makeTest,
    generateRouteTypes,
    generatePageTypes,
    generateDataTypes,
    generateChannelTypes,
    generateAgentTypes,
    generateApiClientTypes,
    buildDocsGraphReport,
    renderDocsGraphMarkdown,
    ...createFreshContextApi(),
  }
}

/**
 * The Dev MCP endpoint (`GUREN_MCP=1`, RFC 0028 §1), serving the 2026-07-28 MCP
 * revision and 2025-era clients from one handler.
 * `createMcpHandler` validates no Origin or peer; the mounting side keeps its guard.
 * The SDK loads on the first request: a static import in this package-index module
 * costs every consumer of it (the edit hook, `deploy-check`) ~40 ms it never uses.
 */
export function createDevMcpHandler(options: CreateDevMcpHandlerOptions): DevMcpHandler {
  const api = options.api ?? defaultApi()
  let started: Promise<DevMcpHandler> | undefined

  const start = (): Promise<DevMcpHandler> => {
    started ??= import('./serve').then(({ startDevMcp }) =>
      startDevMcp({ cwd: options.cwd, api, version: options.version }),
    )
    return started
  }

  return {
    fetch: async (request) => (await start()).fetch(request),
    close: async () => {
      if (started) await (await started).close()
    },
  }
}
