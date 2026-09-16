/**
 * One `tools/call` over the external-auth seam, dispatched with the execution
 * context the Workers runtime would pass. Shared by the two deferral suites
 * because it is this package's only description of how a request crosses that
 * seam holding one: the protocol version, the header set and the seam's
 * principal are pinned here rather than twice. The SDK client is not used — it
 * owns the `fetch` it calls, and the third `app.fetch` argument is the point.
 * It sends the 2025 handshake by hand, so it is also the legacy-era wire case.
 */
import type { Application } from '@guren/core'

import { presentExternalMcpAuth } from './external-auth'

export interface SeamToolCall {
  tool: string
  arguments?: Record<string, unknown>
  /** Omitted, the endpoint sees no context — which is every runtime but Workers. */
  executionCtx?: unknown
}

/** The `tools/call` result; a refusal is still a result, carrying `isError`. */
export interface SeamToolResult {
  content: Array<{ type: string; text?: string }>
  isError?: boolean
}

export async function callToolOverSeam(app: Application, call: SeamToolCall): Promise<SeamToolResult> {
  // Each step must answer 200 with a JSON-RPC result before the next runs: a
  // discarded response would pass a 500 as readily as a success.
  const send = async (id: number, method: string, params: unknown): Promise<unknown> => {
    const request = presentExternalMcpAuth(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      }),
      { principal: { kind: 'user', id: 'u_1', abilities: ['tools:*'] }, scopes: ['tools:*'] },
    )
    const response = await app.fetch(request, undefined, call.executionCtx as never)
    const text = await response.text()
    if (response.status !== 200) {
      throw new Error(`${method} answered ${response.status}: ${text}`)
    }
    const message = parseJsonRpc(text, response.headers.get('Content-Type'))
    if (!('result' in message)) {
      throw new Error(`${method} answered a JSON-RPC error: ${text}`)
    }
    return message.result
  }

  await send(1, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 't', version: '1' },
  })
  return (await send(2, 'tools/call', { name: call.tool, arguments: call.arguments ?? {} })) as SeamToolResult
}

/** The stateless transport answers either as JSON or as a one-event SSE stream. */
function parseJsonRpc(text: string, contentType: string | null): { result?: unknown } {
  if (!contentType?.includes('text/event-stream')) {
    return JSON.parse(text) as { result?: unknown }
  }
  const data = text.split('\n').find((line) => line.startsWith('data: '))
  if (!data) throw new Error(`Expected an SSE data event, got: ${text}`)
  return JSON.parse(data.slice('data: '.length)) as { result?: unknown }
}

/** The context shape workerd hands `fetch`, with `waitUntil` collecting instead of running. */
export function recordingExecutionContext(deferred: Promise<unknown>[]): unknown {
  return {
    waitUntil: (work: Promise<unknown>) => void deferred.push(work),
    passThroughOnException: () => {},
    props: {},
  }
}
