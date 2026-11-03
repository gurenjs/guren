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
  InertiaPageObject,
} from '@guren/core'

export const MCP_APPS_EXTENSION_ID = 'io.modelcontextprotocol/ui'
export const MCP_APP_MIME_TYPE = 'text/html;profile=mcp-app'
/** Read by hosts that predate the nested `_meta.ui.resourceUri`; the specification drops it before GA. */
const LEGACY_RESOURCE_URI_KEY = 'ui/resourceUri'
export const RESPONSE_META_KEY = 'dev.guren/response'
export const INERTIA_PAGE_META_KEY = 'dev.guren/inertia-page'

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
   * Shared Inertia props an App MCP tool call carries, to the model and to a
   * view alike. Default none: every other key is dropped once the `share()` resolvers ran.
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

export function pageResourceUri(ui: AppMcpUi, page: string, hash: string): string {
  return `ui://${ui.authority}/pages/${page}?v=${hash}`
}

export function bridgeResourceUri(ui: AppMcpUi): string {
  return `ui://${ui.authority}/bridge`
}

/** The built page a tool's view loads, or undefined when it declares none or none was built. */
function builtPage(tool: DerivedAgentTool, ui: AppMcpUi | undefined): { page: string; built: McpAppPage } | undefined {
  const page = tool.ui?.page
  if (page === undefined || !ui?.pages) return undefined
  const built = ui.pages[page]
  return built ? { page, built } : undefined
}

/**
 * `_meta` for a tool in `tools/list`. A page with no build loses its URI, never
 * its visibility: dropping `ui` would show an app-only tool to the model.
 */
export function toolUiMeta(tool: DerivedAgentTool, ui: AppMcpUi | undefined): Record<string, unknown> | undefined {
  if (!tool.ui) return undefined
  const page = builtPage(tool, ui)
  if (!page || !ui) return { ui: { visibility: tool.ui.visibility } }
  const resourceUri = pageResourceUri(ui, page.page, page.built.hash)
  return { ui: { resourceUri, visibility: tool.ui.visibility }, [LEGACY_RESOURCE_URI_KEY]: resourceUri }
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

export interface UiResourceEntry {
  uri: string
  name: string
  mimeType: string
  _meta?: Record<string, unknown>
}

/** `resources/list`: one entry per built page the listed tools name, plus the bridge catalogue. */
export function listUiResources(listed: readonly DerivedAgentTool[], ui: AppMcpUi | undefined): UiResourceEntry[] {
  if (!ui || !listed.some((tool) => tool.ui)) return []
  const entries = new Map<string, UiResourceEntry>()
  for (const tool of listed) {
    const page = builtPage(tool, ui)
    if (!page || entries.has(page.page)) continue
    entries.set(page.page, {
      uri: pageResourceUri(ui, page.page, page.built.hash),
      name: page.page,
      mimeType: MCP_APP_MIME_TYPE,
      _meta: { ui: resourceUiMeta(ui, page.page) },
    })
  }
  return [
    ...entries.values(),
    { uri: bridgeResourceUri(ui), name: 'guren-bridge', mimeType: 'application/json' },
  ]
}

export interface UiResourceContents {
  uri: string
  mimeType: string
  text: string
  _meta?: Record<string, unknown>
}

/**
 * `resources/read`, for a URI the caller's listing contains; undefined for any
 * other, including a page URI naming a stale build.
 */
export function readUiResource(
  uri: string,
  listed: readonly DerivedAgentTool[],
  ui: AppMcpUi | undefined,
): UiResourceContents | undefined {
  const entry = listUiResources(listed, ui).find((candidate) => candidate.uri === uri)
  if (!entry || !ui) return undefined
  if (entry.mimeType === MCP_APP_MIME_TYPE) {
    const built = ui.pages?.[entry.name]
    if (!built) return undefined
    return { uri, mimeType: MCP_APP_MIME_TYPE, text: built.html, _meta: { ui: resourceUiMeta(ui, entry.name) } }
  }
  return { uri, mimeType: 'application/json', text: JSON.stringify({ tools: bridgeCatalogue(listed) }) }
}

/**
 * What the view's bridge needs to turn a visit into a call (RFC 0038 §5), for
 * the tools this caller can already call, in registration order. Discloses
 * each tool's method and path beyond `tools/list`, and nothing else.
 */
function bridgeCatalogue(listed: readonly DerivedAgentTool[]): Array<Record<string, unknown>> {
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
  if (result.status === 'failed') {
    return { [RESPONSE_META_KEY]: { outcome: 'failed', message: result.message } satisfies GurenToolResponse }
  }
  if (result.status === 'denied') {
    const { reason, message, body } = result.denial
    const approval = typeof body?.requestId === 'string' && typeof body.status === 'string'
      ? { requestId: body.requestId, status: body.status as AgentApprovalStatus | 'spent' }
      : undefined
    const response: GurenToolResponse = { outcome: 'denied', reason, message, ...(approval ? { approval } : {}) }
    return { [RESPONSE_META_KEY]: response }
  }

  const { outcome } = result
  const page = tool.ui?.page !== undefined ? outcome.inertiaPage : undefined
  const response: GurenToolResponse = {
    outcome: 'executed',
    status: outcome.status,
    ...(page ? { url: absolute(page.url, appOrigin) } : {}),
    ...(outcome.location ? { location: absolute(outcome.location, appOrigin) } : {}),
    ...(outcome.errors ? { errors: outcome.errors } : {}),
  }
  return {
    [RESPONSE_META_KEY]: response,
    ...(page ? { [INERTIA_PAGE_META_KEY]: relativePage(page) } : {}),
  }
}

/** Inertia writes `url` into the frame's history, which refuses another origin (RFC 0038 §5). */
function relativePage(page: InertiaPageObject): InertiaPageObject {
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
