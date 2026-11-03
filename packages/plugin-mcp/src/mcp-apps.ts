/**
 * MCP Apps (SEP-1865, `2026-01-26`) on the App MCP endpoint: RFC 0038 §3 and §6.
 * Pure: the per-request server calls these with the tools a caller can see, so
 * a page and the bridge catalogue are published by the same filter as `tools/list`.
 */
import type {
  AgentApprovalStatus,
  AgentInvocationResult,
  AgentToolDenialReason,
  DerivedAgentTool,
  InertiaPagePayload,
} from '@guren/core'

export const MCP_APPS_EXTENSION_ID = 'io.modelcontextprotocol/ui'
const MCP_APP_MIME_TYPE = 'text/html;profile=mcp-app'
/** Read by hosts that predate the nested `_meta.ui.resourceUri`; the specification drops it before GA. */
const LEGACY_RESOURCE_URI_KEY = 'ui/resourceUri'
const RESPONSE_META_KEY = 'dev.guren/response'
const INERTIA_PAGE_META_KEY = 'dev.guren/inertia-page'

/** One built page: its whole HTML document and the content hash its URI carries. */
export interface McpAppPage {
  html: string
  hash: string
}

/** What `vite build --mode mcp-app` writes to `.guren/mcp-app/index.gen.ts`. */
export interface McpAppPagesModule {
  mcpAppPages: Readonly<Record<string, McpAppPage>>
}

/** `_meta.ui.csp` of a UI resource, as the specification names its fields. */
export interface McpAppCsp {
  connectDomains?: string[]
  resourceDomains?: string[]
  frameDomains?: string[]
  baseUriDomains?: string[]
}

export interface McpAppPermissions {
  camera?: Record<string, never>
  microphone?: Record<string, never>
  geolocation?: Record<string, never>
  clipboardWrite?: Record<string, never>
}

/** `mcpPlugin({ ui })`. */
export interface McpUiConfig {
  /** The built pages, as a module so every deploy bundler inlines them: `() => import('@/.guren/mcp-app/index.gen')`. */
  pages?: () => McpAppPagesModule | Promise<McpAppPagesModule>
  /** Presentation per page id. Per page, not per route, so two routes naming one page cannot disagree. */
  presentation?: Readonly<Record<string, { prefersBorder?: boolean }>>
  /** Origins the views may use. Every one widens the default CSP; `guren audit` names each. */
  csp?: McpAppCsp
  permissions?: McpAppPermissions
  /** Host-specific dedicated origin, passed through unvalidated. */
  domain?: string
  /**
   * Shared Inertia props an App MCP tool call carries, to the model and to a view
   * alike. Default none, which runs no `share()` resolver for a tool call at all.
   */
  sharedProps?: readonly string[]
}

/** What one request's server needs to serve MCP Apps. */
export interface AppMcpUi {
  /** The `ui://` authority: the server name, reduced to a URI-safe label. */
  authority: string
  /** Built pages, or undefined when the app configured none or they failed to load. */
  pages: Readonly<Record<string, McpAppPage>> | undefined
  config: McpUiConfig
}

export function uiAuthority(serverName: string): string {
  const label = serverName.toLowerCase().replace(/[^a-z0-9.-]+/g, '-').replace(/^-+|-+$/g, '')
  return label === '' ? 'guren-app' : label
}

interface BuiltPage {
  page: string
  built: McpAppPage
  uri: string
}

/** The built page a tool's view loads, or undefined when it declares none or none was built. */
function builtPage(tool: DerivedAgentTool, ui: AppMcpUi | undefined): BuiltPage | undefined {
  const page = tool.ui?.page
  if (page === undefined || !ui?.pages) return undefined
  const built = ui.pages[page]
  return built ? { page, built, uri: `ui://${ui.authority}/pages/${page}?v=${built.hash}` } : undefined
}

/**
 * `_meta` for a tool in `tools/list`. A page with no build loses its URI, never
 * its visibility: dropping `ui` would show an app-only tool to the model.
 */
export function toolUiMeta(tool: DerivedAgentTool, ui: AppMcpUi | undefined): Record<string, unknown> | undefined {
  if (!tool.ui) return undefined
  const page = builtPage(tool, ui)
  if (!page) return { ui: { visibility: tool.ui.visibility } }
  return { ui: { resourceUri: page.uri, visibility: tool.ui.visibility }, [LEGACY_RESOURCE_URI_KEY]: page.uri }
}

/** The page ids some tool declares with no build behind it, for the warning the plugin prints once. */
export function unbuiltPages(tools: readonly DerivedAgentTool[], ui: AppMcpUi | undefined): string[] {
  const missing = new Set<string>()
  for (const tool of tools) {
    if (tool.ui?.page !== undefined && !builtPage(tool, ui)) missing.add(tool.ui.page)
  }
  return Array.from(missing).sort()
}

function resourceUiMeta(ui: AppMcpUi, page: string): Record<string, unknown> {
  const prefersBorder = ui.config.presentation?.[page]?.prefersBorder
  return {
    csp: ui.config.csp ?? {},
    ...(ui.config.permissions ? { permissions: ui.config.permissions } : {}),
    ...(ui.config.domain ? { domain: ui.config.domain } : {}),
    ...(prefersBorder === undefined ? {} : { prefersBorder }),
  }
}

/** The distinct built pages the listed tools name, in listing order. */
function listedPages(listed: readonly DerivedAgentTool[], ui: AppMcpUi): BuiltPage[] {
  const pages = new Map<string, BuiltPage>()
  for (const tool of listed) {
    const page = builtPage(tool, ui)
    if (page && !pages.has(page.page)) pages.set(page.page, page)
  }
  return [...pages.values()]
}

/** `resources/list`: one entry per built page the listed tools name, plus the bridge catalogue. */
export function listUiResources(listed: readonly DerivedAgentTool[], ui: AppMcpUi | undefined) {
  if (!ui || !listed.some((tool) => tool.ui)) return []
  return [
    ...listedPages(listed, ui).map((page) => ({
      uri: page.uri,
      name: page.page,
      mimeType: MCP_APP_MIME_TYPE,
      _meta: { ui: resourceUiMeta(ui, page.page) },
    })),
    { uri: bridgeUri(ui), name: 'guren-bridge', mimeType: 'application/json' },
  ]
}

/**
 * `resources/read`, for a URI the caller's listing contains; undefined for any
 * other, including a page URI naming a stale build.
 */
export function readUiResource(uri: string, listed: readonly DerivedAgentTool[], ui: AppMcpUi | undefined) {
  if (!ui || !listed.some((tool) => tool.ui)) return undefined
  if (uri === bridgeUri(ui)) {
    return { uri, mimeType: 'application/json', text: JSON.stringify({ tools: bridgeCatalogue(listed) }) }
  }
  const page = listedPages(listed, ui).find((candidate) => candidate.uri === uri)
  if (!page) return undefined
  return { uri, mimeType: MCP_APP_MIME_TYPE, text: page.built.html, _meta: { ui: resourceUiMeta(ui, page.page) } }
}

function bridgeUri(ui: AppMcpUi): string {
  return `ui://${ui.authority}/bridge`
}

/** One tool as the view's bridge reads it: what `buildToolRequest()` needs, and whether a visit can be one call. */
export type BridgeCatalogueEntry =
  Pick<DerivedAgentTool, 'toolName' | 'method' | 'path' | 'inputSources' | 'inputBodyNested'> & { bridgeable: boolean }

/**
 * What the view's bridge needs to turn a visit into a call (RFC 0038 §5), for
 * the tools this caller can already call, in registration order. Discloses
 * each tool's method and path beyond `tools/list`, and nothing else.
 */
function bridgeCatalogue(listed: readonly DerivedAgentTool[]): BridgeCatalogueEntry[] {
  return listed.map((tool) => ({
    toolName: tool.toolName,
    method: tool.method,
    path: tool.path,
    inputSources: tool.inputSources,
    inputBodyNested: tool.inputBodyNested,
    // A visit carrying both colliding inputs cannot be one flat call.
    bridgeable: tool.inputCollisions === undefined,
  }))
}

export type GurenToolResponse =
  | { outcome: 'executed'; status: number; url?: string; location?: string; errors?: Record<string, string[]> }
  | {
    outcome: 'denied'
    reason: AgentToolDenialReason
    message: string
    approval?: { requestId: string; status: AgentApprovalStatus | 'spent' }
  }
  | { outcome: 'failed'; message: string }

/**
 * The result `_meta` every route tool's answer carries, built from the
 * pipeline's result rather than from `content`, whose text promises no format.
 * `appOrigin` absolutizes what a view hands off to the browser.
 */
export function resultMeta(
  tool: DerivedAgentTool,
  result: AgentInvocationResult,
  appOrigin: string,
): Record<string, unknown> {
  const page = result.status === 'executed' && tool.ui?.page !== undefined ? result.outcome.inertiaPage : undefined
  return {
    [RESPONSE_META_KEY]: toolResponse(result, page, appOrigin),
    ...(page ? { [INERTIA_PAGE_META_KEY]: relativePage(page) } : {}),
  }
}

function toolResponse(
  result: AgentInvocationResult,
  page: InertiaPagePayload | undefined,
  appOrigin: string,
): GurenToolResponse {
  if (result.status === 'failed') return { outcome: 'failed', message: result.message }
  if (result.status === 'denied') {
    const { reason, message, body } = result.denial
    const approval = typeof body?.requestId === 'string' && typeof body.status === 'string'
      ? { requestId: body.requestId, status: body.status as AgentApprovalStatus | 'spent' }
      : undefined
    return { outcome: 'denied', reason, message, ...(approval ? { approval } : {}) }
  }
  const { outcome } = result
  return {
    outcome: 'executed',
    status: outcome.status,
    ...(page ? { url: absolute(page.url, appOrigin) } : {}),
    ...(outcome.location ? { location: absolute(outcome.location, appOrigin) } : {}),
    ...(outcome.errors ? { errors: outcome.errors } : {}),
  }
}

/** Inertia writes `url` into the frame's history, which refuses another origin (RFC 0038 §5). */
function relativePage(page: InertiaPagePayload): InertiaPagePayload {
  try {
    const url = new URL(page.url, 'http://relative.invalid')
    return { ...page, url: `${url.pathname}${url.search}` }
  } catch {
    return page
  }
}

function absolute(url: string, origin: string): string {
  try {
    return new URL(url, origin).href
  } catch {
    return url
  }
}
