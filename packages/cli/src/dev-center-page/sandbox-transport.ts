import type { StreamableHTTPClientTransport } from '@modelcontextprotocol/client'

export type JsonRpcMessage = Parameters<NonNullable<StreamableHTTPClientTransport['onmessage']>>[0]

type MessageTarget = Pick<Window, 'addEventListener' | 'removeEventListener'>

/**
 * The host's end of the postMessage channel to the sandbox proxy. `PostMessageTransport` posts
 * to `'*'` and checks only the source window, so this one names the proxy's origin both ways.
 */
export class SandboxTransport {
  onmessage?: (message: JsonRpcMessage) => void
  onclose?: () => void
  onerror?: (error: Error) => void
  private readonly listener = (event: MessageEvent<unknown>) => {
    if (event.source !== this.frame.contentWindow || event.origin !== this.origin) return
    const data = event.data as { jsonrpc?: unknown } | null
    if (data === null || typeof data !== 'object' || data.jsonrpc !== '2.0') return
    this.log('view', data)
    this.onmessage?.(data as JsonRpcMessage)
  }

  constructor(
    private readonly frame: Pick<HTMLIFrameElement, 'contentWindow'>,
    private readonly origin: string,
    private readonly log: (from: 'view' | 'host', message: unknown) => void,
    private readonly target: MessageTarget = window,
  ) {}

  async start(): Promise<void> {
    this.target.addEventListener('message', this.listener as EventListener)
  }

  async send(message: JsonRpcMessage): Promise<void> {
    this.log('host', message)
    this.frame.contentWindow?.postMessage(message, this.origin)
  }

  async close(): Promise<void> {
    this.target.removeEventListener('message', this.listener as EventListener)
    this.onclose?.()
  }
}
