import { createMcpHandler } from '@modelcontextprotocol/server'

import { runCheck } from '../check'
import { generateChannelTypes } from '../channel-types'
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
import { makeRoute } from '../make-route'
import { makeTest } from '../make-test'
import { makeView } from '../make-view'
import { listModels } from '../model-list'
import { generatePageTypes } from '../pages-types'
import { generateRouteTypes } from '../routes-types'
import { generateAgentTypes } from '../agents-types'
import { generateApiClientTypes } from '../api-client-types'
import { createDevMcpServer, type DevMcpApi } from './server'

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
    makeRoute,
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
 * revision and 2025-era clients from one handler. Origin and peer checks are not
 * here: `createMcpHandler` performs none, so the mounting side keeps its guard.
 */
export function createDevMcpHandler(options: CreateDevMcpHandlerOptions): DevMcpHandler {
  const api = options.api ?? defaultApi()
  const handler = createMcpHandler(() =>
    createDevMcpServer({ cwd: options.cwd, api, version: options.version }),
  )

  return {
    fetch: (request) => handler.fetch(request),
    close: () => handler.close(),
  }
}
