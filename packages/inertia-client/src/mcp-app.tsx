/**
 * `@guren/inertia-client/mcp-app` (RFC 0038 §5): mounts an Inertia page inside
 * an MCP Apps host, from the tool result the host hands the view, and answers
 * its visits through the host. `@modelcontextprotocol/ext-apps` is loaded only
 * by `startMcpApp()`, so a page importing `useMcpApp()` in the ordinary app
 * bundles nothing of it.
 */
import { router, type Page } from '@inertiajs/core'
import { useSyncExternalStore } from 'react'
import { mountInertiaApp, type StartInertiaClientOptions } from './app'
import {
  BridgeCatalogue,
  createMcpAppHttpClient,
  MCP_APP_CONTRACT,
  readToolResult,
  type BridgeTool,
  type PendingApprovalVisit,
  type ToolResultLike,
} from './mcp-app-bridge'
import { installMemoryHistory } from './mcp-app-history'
import { createPagesResolver } from './resolve'

export { MCP_APP_CONTRACT, MCP_APP_ERROR_KEY } from './mcp-app-bridge'

/** Restated from `APPROVAL_STATUS_TOOL_NAME` in `@guren/server`, which a browser bundle cannot import. */
const APPROVAL_STATUS_TOOL = 'guren_approval_status'
const APPROVAL_POLL_MS = 3000

/** The members of ext-apps' `App` this module calls, so a test can hand in a fake. */
export interface McpAppHost {
  connect(): Promise<void>
  getHostCapabilities(): McpAppHostCapabilities | undefined
  getHostContext(): Record<string, unknown> | undefined
  callServerTool(params: { name: string; arguments?: Record<string, unknown> }): Promise<ToolResultLike>
  readServerResource(params: { uri: string }): Promise<{ contents: Array<{ text?: string }> }>
  openLink(params: { url: string }): Promise<unknown>
  sendMessage(params: unknown): Promise<unknown>
  updateModelContext(params: unknown): Promise<unknown>
  ontoolresult?: ((params: ToolResultLike) => void) | undefined
  ontoolcancelled?: ((params: unknown) => void) | undefined
  onhostcontextchanged?: ((params: Record<string, unknown>) => void) | undefined
}

export interface McpAppHostCapabilities {
  serverTools?: unknown
  serverResources?: unknown
  openLinks?: unknown
  [capability: string]: unknown
}

export interface StartMcpAppOptions extends Omit<StartInertiaClientOptions, 'page' | 'prototype' | 'live'> {
  appInfo?: { name: string; version: string }
  /** An already constructed host connection; by default ext-apps' `App`. */
  host?: McpAppHost
  /** Where status text goes until the page mounts. Default `#app`. */
  element?: HTMLElement | null
}

export type PendingApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired' | 'unknown'

export interface PendingApproval {
  requestId: string
  toolName: string
  status: PendingApprovalStatus
  /** Repeats the refused visit with the same input, which an approved request requires. */
  resubmit(): void
  dismiss(): void
}

export interface McpAppState {
  isMcpApp: boolean
  hostContext?: Record<string, unknown>
  hostCapabilities?: McpAppHostCapabilities
  /** False when visits cannot become tool calls: no `serverTools`, no catalogue, or a server on another contract. */
  interactive: boolean
  pendingApproval?: PendingApproval
  /** A URL the host could not open (no `openLinks`), for the page to show. */
  handOff?: string
  /**
   * The last visit the view could not carry out. It also lands in the page's
   * `errors.mcp`, which a page written for the browser never shows, so a layout
   * can render this with a link to `url`, the page in the application.
   */
  refusal?: { message: string; url?: string }
  sendMessage(params: unknown): Promise<unknown>
  updateModelContext(params: unknown): Promise<unknown>
  openLink(url: string): Promise<unknown>
}

const outsideHost = (): Promise<never> => Promise.reject(new Error('Not running inside an MCP App host.'))
let state: McpAppState = {
  isMcpApp: false,
  interactive: false,
  sendMessage: outsideHost,
  updateModelContext: outsideHost,
  openLink: outsideHost,
}
const listeners = new Set<() => void>()

function update(patch: Partial<McpAppState>): void {
  state = { ...state, ...patch }
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The same state outside React, read once. */
export function getMcpAppState(): McpAppState {
  return state
}

/** The host around this view; `isMcpApp` is false in the ordinary app, where every action rejects. */
export function useMcpApp(): McpAppState {
  return useSyncExternalStore(subscribe, () => state, () => state)
}

/** Connect to the host, wait for the tool result, and mount its page. */
export async function startMcpApp(options: StartMcpAppOptions): Promise<unknown> {
  const element = options.element === undefined && typeof document !== 'undefined' ? document.getElementById('app') : options.element
  const status = (text: string) => {
    if (element) element.textContent = text
  }
  const host = options.host ?? await createHost(options.appInfo)

  const result = new Promise<ToolResultLike | undefined>((resolve) => {
    host.ontoolresult = (params) => resolve(params)
    host.ontoolcancelled = () => resolve(undefined)
  })
  try {
    await host.connect()
  } catch {
    // Opened outside a host (or a host that refused `ui/initialize`): nothing will answer.
    status('This view runs inside an MCP Apps host, such as Claude or ChatGPT.')
    return undefined
  }
  const capabilities = host.getHostCapabilities()
  host.onhostcontextchanged = (context) => update({ hostContext: { ...state.hostContext, ...context } })
  update({
    isMcpApp: true,
    hostCapabilities: capabilities,
    hostContext: host.getHostContext(),
    sendMessage: (params) => host.sendMessage(params),
    updateModelContext: (params) => host.updateModelContext(params),
    openLink: (url) => host.openLink({ url }),
  })

  status('Loading…')
  const answered = await result
  if (!answered) {
    status('The tool call was cancelled.')
    return undefined
  }
  const { response, page } = readToolResult(answered)
  if (!page) {
    status(firstText(answered) ?? 'The tool returned no page to show.')
    return undefined
  }

  const appOrigin = originOf(response?.outcome === 'executed' ? response.url : undefined)
  const catalogue = response?.contract === MCP_APP_CONTRACT && capabilities?.serverTools && response.bridge
    ? await readCatalogue(host, response.bridge)
    : undefined
  update({ interactive: catalogue !== undefined })

  installMemoryHistory(window, page.url)
  let current: Page = page
  router.on('navigate', (event) => {
    current = event.detail.page
  })

  const resolve = options.resolve ?? createPagesResolver({
    pages: options.pages,
    pageManifest: options.pageManifest,
    resolveComponentPath: options.resolveComponentPath,
  })
  const http = createMcpAppHttpClient({
    call: (name, args) => host.callServerTool({ name, arguments: args }),
    catalogue: () => catalogue,
    origins: () => ({ sandbox: window.location.origin, app: appOrigin }),
    currentPage: () => current,
    hasComponent: async (name) => {
      try {
        await resolve(name)
        return true
      } catch {
        return false
      }
    },
    handOff: (url) => {
      if (!capabilities?.openLinks) {
        update({ handOff: url })
        return
      }
      // A host that declines (a blocked domain, the user cancelling) resolves with `isError`.
      void host.openLink({ url }).then(
        (opened) => {
          if ((opened as { isError?: boolean } | undefined)?.isError) update({ handOff: url })
        },
        () => update({ handOff: url }),
      )
    },
    pendingApproval: (visit) => watchApproval(host, visit),
    refused: (refusal) => update({ refusal }),
  })
  return mountInertiaApp({ ...options, resolve }, page, http)
}

async function createHost(appInfo: StartMcpAppOptions['appInfo']): Promise<McpAppHost> {
  const { App } = await import('@modelcontextprotocol/ext-apps')
  return new App(appInfo ?? { name: 'guren-mcp-app', version: '1.0.0' }, {}) as unknown as McpAppHost
}

async function readCatalogue(host: McpAppHost, uri: string): Promise<BridgeCatalogue | undefined> {
  try {
    const { contents } = await host.readServerResource({ uri })
    const parsed = JSON.parse(contents[0]?.text ?? '') as { tools?: BridgeTool[] }
    return Array.isArray(parsed.tools) ? new BridgeCatalogue(parsed.tools) : undefined
  } catch {
    return undefined
  }
}

/** Polls the request while the view is open; approval executes nothing, so the visit is resubmitted by the page. */
function watchApproval(host: McpAppHost, visit: PendingApprovalVisit): void {
  let timer: ReturnType<typeof setTimeout> | undefined
  const stop = () => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
  }
  const approval = (status: PendingApprovalStatus): PendingApproval => ({
    requestId: visit.requestId,
    toolName: visit.toolName,
    status,
    resubmit: () => {
      stop()
      update({ pendingApproval: undefined })
      router.visit(visit.url, { method: visit.method.toLowerCase() as 'get', data: visit.data as Record<string, never> })
    },
    dismiss: () => {
      stop()
      update({ pendingApproval: undefined })
    },
  })
  const poll = async () => {
    if (state.pendingApproval?.requestId !== visit.requestId) return
    try {
      const result = await host.callServerTool({ name: APPROVAL_STATUS_TOOL, arguments: { requestId: visit.requestId } })
      const reported = (result.structuredContent as { status?: string } | undefined)?.status
      const status: PendingApprovalStatus = reported === 'pending' || reported === 'approved' || reported === 'rejected' || reported === 'expired'
        ? reported
        : 'unknown'
      if (state.pendingApproval?.requestId !== visit.requestId) return
      update({ pendingApproval: approval(status) })
      if (status === 'pending') timer = setTimeout(poll, APPROVAL_POLL_MS)
    } catch {
      timer = setTimeout(poll, APPROVAL_POLL_MS)
    }
  }
  state.pendingApproval?.dismiss()
  update({ pendingApproval: approval('pending') })
  timer = setTimeout(poll, APPROVAL_POLL_MS)
}

function firstText(result: ToolResultLike): string | undefined {
  const content = Array.isArray(result.content) ? result.content : []
  const block = content.find((item): item is { type: 'text'; text: string } =>
    typeof item === 'object' && item !== null && (item as { type?: unknown }).type === 'text')
  return block?.text
}

function originOf(url: string | undefined): string | undefined {
  if (!url) return undefined
  try {
    return new URL(url).origin
  } catch {
    return undefined
  }
}
