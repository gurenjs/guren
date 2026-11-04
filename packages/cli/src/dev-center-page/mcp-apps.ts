import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { AppBridge, getToolUiResourceUri } from '@modelcontextprotocol/ext-apps/app-bridge'
import { MCP_APPS_SANDBOX_PATH, mcpAppsSandboxOrigin } from '../dev-center-links'
import { commandRow, el } from '../docs-viewer-page/dom'
import { gurenCommandLine } from '../shell-quote'
import { card } from './dom'
import { SandboxTransport } from './sandbox-transport'

type Tool = Awaited<ReturnType<Client['listTools']>>['tools'][number]

const RESERVED = 'ui/notifications/sandbox-'
const TOKEN_COMMAND = gurenCommandLine(['token:issue', '--name', 'dev-center', '--user', '<user id>', '--tools', 'tools:read', '--expires', '12h'])

function describeMessage(message: unknown): string {
  const data = message as { method?: unknown; id?: unknown; error?: { message?: unknown } } | null
  if (data && typeof data.method === 'string') return data.id === undefined ? data.method : `${data.method} #${String(data.id)}`
  if (data && data.error) return `error #${String(data.id)}: ${String(data.error.message ?? '')}`
  return `result #${String(data?.id)}`
}

function messageLog(): { node: HTMLElement; add(from: 'view' | 'host', message: unknown): void; note(text: string): void } {
  const list = el('ol', 'mcp-log mono')
  const add = (from: string, text: string, message?: unknown) => {
    const item = el('li')
    const head = el('div', '', `${from === 'view' ? 'view → host' : from === 'host' ? 'host → view' : 'host'}  ${text}`)
    item.append(head)
    if (message !== undefined) {
      const details = el('details')
      details.append(el('summary', 'meta', 'message'), el('pre', '', JSON.stringify(message, null, 2)))
      item.append(details)
    }
    list.append(item)
  }
  return {
    node: list,
    add: (from, message) => add(from, describeMessage(message), message),
    note: (text) => add('note', text),
  }
}

function argumentHint(tool: Tool): string {
  const properties = Object.keys(tool.inputSchema.properties ?? {})
  if (properties.length === 0) return 'This tool takes no arguments.'
  const required = new Set(tool.inputSchema.required ?? [])
  return `Arguments: ${properties.map((name) => `${name}${required.has(name) ? '' : '?'}`).join(', ')}`
}

function failure(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

interface PreviewState {
  client?: Client
  bridge?: AppBridge
  frame?: HTMLIFrameElement
}

async function renderView(client: Client, tool: Tool, args: Record<string, unknown>, sandboxOrigin: string, view: HTMLElement, state: PreviewState): Promise<void> {
  await state.bridge?.close().catch(() => undefined)
  state.frame?.remove()
  const log = messageLog()
  const frameBox = el('div', 'mcp-frame')
  view.replaceChildren(card(`View: ${tool.name}`, frameBox), card('Messages', log.node))

  const uri = getToolUiResourceUri(tool)
  if (!uri) return
  const result = await client.callTool({ name: tool.name, arguments: args })
  log.note(`tools/call ${tool.name}${result.isError ? ' returned an error' : ''}`)
  const resource = await client.readResource({ uri })
  const content = resource.contents[0] as { text?: unknown; _meta?: { ui?: { csp?: unknown } } } | undefined
  if (!content || typeof content.text !== 'string') {
    frameBox.replaceChildren(el('p', 'error', `${uri} returned no HTML document. Build the views with bunx vite build --mode mcp-app.`))
    return
  }

  const frame = el('iframe', 'mcp-preview')
  frame.title = `${tool.name} rendered as an MCP App`
  frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms')
  const csp = content._meta?.ui?.csp
  frame.src = `${sandboxOrigin}${MCP_APPS_SANDBOX_PATH}${csp ? `?csp=${encodeURIComponent(JSON.stringify(csp))}` : ''}`
  state.frame = frame

  const bridge = new AppBridge(client, { name: 'Guren Dev Center', version: '1' }, {
    openLinks: {},
    serverTools: {},
    serverResources: {},
    logging: {},
  }, { hostContext: { displayMode: 'inline', availableDisplayModes: ['inline'] } })
  state.bridge = bridge
  bridge.addEventListener('sandboxready', () => {
    void bridge.sendSandboxResourceReady({ html: content.text as string, ...(csp ? { csp } : {}) })
  })
  bridge.oninitialized = () => {
    void bridge.sendToolInput({ arguments: args })
    void bridge.sendToolResult(result)
  }
  bridge.addEventListener('sizechange', ({ height }) => {
    if (typeof height === 'number') frame.style.height = `${Math.ceil(height)}px`
  })
  bridge.onopenlink = async ({ url }) => {
    log.note(`The view asked to open ${url}; a host would ask the user first.`)
    return {}
  }
  bridge.onmessage = async ({ content: blocks }) => {
    log.note(`The view sent a message for the conversation: ${JSON.stringify(blocks)}`)
    return {}
  }
  bridge.onupdatemodelcontext = async () => ({})
  // connect() registers the listener, and the proxy announces itself as soon as it loads: append after.
  await bridge.connect(new SandboxTransport(frame, sandboxOrigin, (from, message) => {
    const method = (message as { method?: unknown } | null)?.method
    if (typeof method === 'string' && method.startsWith(RESERVED)) return
    log.add(from, message)
  }))
  frameBox.append(frame)
}

function toolRow(tool: Tool, preview: (tool: Tool, args: Record<string, unknown>) => Promise<void>): HTMLElement {
  const row = el('div', 'mcp-tool')
  const head = el('div')
  head.append(el('div', 'g-card-title', tool.name), el('div', 'meta mono', getToolUiResourceUri(tool) ?? ''))
  if (tool.description) head.append(el('p', 'meta', tool.description))
  const body = el('div')
  const input = el('textarea', 'g-input mono')
  input.rows = 3
  input.value = '{}'
  input.setAttribute('aria-label', `Arguments for ${tool.name}, as JSON`)
  const status = el('p', 'meta', argumentHint(tool))
  const button = el('button', 'g-btn', 'Call and render')
  button.type = 'button'
  button.onclick = async () => {
    let args: unknown
    try { args = JSON.parse(input.value) } catch { status.textContent = 'The arguments are not JSON.'; status.className = 'error'; return }
    if (args === null || typeof args !== 'object' || Array.isArray(args)) { status.textContent = 'The arguments must be a JSON object.'; status.className = 'error'; return }
    button.disabled = true
    status.textContent = 'Calling…'
    status.className = 'meta'
    try {
      await preview(tool, args as Record<string, unknown>)
      status.textContent = argumentHint(tool)
    } catch (error) {
      status.textContent = failure(error)
      status.className = 'error'
    } finally { button.disabled = false }
  }
  body.append(input, button, status)
  row.append(head, body)
  return row
}

export function startMcpAppsPreview(root: HTMLElement): void {
  const sandboxOrigin = mcpAppsSandboxOrigin(location.origin)
  if (!sandboxOrigin) {
    const here = new URL(location.href)
    here.hostname = 'localhost'
    const notice = el('p', 'warning')
    notice.append('The preview loads each view through a sandbox on 127.0.0.1, which must be another origin than this page. Open it on ', el('code', 'mono', here.href), '.')
    root.replaceChildren(notice)
    return
  }

  const endpoint = el('input', 'g-input mono')
  endpoint.value = '/mcp'
  endpoint.setAttribute('aria-label', 'App MCP endpoint path')
  const token = el('input', 'g-input mono')
  token.type = 'password'
  token.autocomplete = 'off'
  token.placeholder = 'API token'
  token.setAttribute('aria-label', 'API token')
  const connect = el('button', 'g-btn', 'List tools')
  connect.type = 'button'
  const status = el('p', 'meta', '')
  status.setAttribute('role', 'status')
  const tools = el('div')
  const view = el('div')
  const intro = el('p', 'meta', 'Issue a token for the user the tools should run as, then paste it here. It stays in this page\'s memory and is sent only to the App MCP endpoint on this origin.')
  const fields = el('div', 'toolbar')
  fields.append(endpoint, token, connect)
  root.replaceChildren(card('Connect', intro, commandRow(TOKEN_COMMAND), fields, status), tools, view)

  const state: PreviewState = {}
  connect.onclick = async () => {
    connect.disabled = true
    status.textContent = 'Listing tools…'
    status.className = 'meta'
    try {
      await state.bridge?.close().catch(() => undefined)
      await state.client?.close().catch(() => undefined)
      const client = new Client({ name: 'guren-dev-center', version: '1' })
      state.client = client
      await client.connect(new StreamableHTTPClientTransport(new URL(endpoint.value, location.origin), {
        requestInit: { headers: { Authorization: `Bearer ${token.value.trim()}` } },
      }))
      const listed = (await client.listTools()).tools.filter((tool) => getToolUiResourceUri(tool) !== undefined)
      status.textContent = listed.length === 0
        ? 'Connected, but no tool this token can see declares a view. Add .agent({ ui }) to a route and build the views.'
        : `${listed.length} tool${listed.length === 1 ? '' : 's'} with a view.`
      // One render at a time: each closes the bridge before it, which a render still connecting has not set yet.
      const preview = async (chosen: Tool, args: Record<string, unknown>) => {
        const buttons = [...tools.querySelectorAll('button')]
        for (const button of buttons) button.disabled = true
        try { await renderView(client, chosen, args, sandboxOrigin, view, state) }
        finally { for (const button of buttons) button.disabled = false }
      }
      tools.replaceChildren(...(listed.length === 0 ? [] : [card('Tools with a view', ...listed.map((tool) => toolRow(tool, preview)))]))
    } catch (error) {
      status.textContent = `Could not reach ${endpoint.value}: ${failure(error)}. Check that mcpPlugin() is registered at this path and that the token is valid.`
      status.className = 'error'
    } finally { connect.disabled = false }
  }
}
