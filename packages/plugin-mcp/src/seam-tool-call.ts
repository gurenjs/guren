/**
 * One `tools/call` over the external-auth seam, dispatched with the execution
 * context the Workers runtime would pass. Shared by the two deferral suites
 * because it is this package's only description of how a request crosses that
 * seam holding one: the protocol version, the header set and the seam's
 * principal are pinned here rather than twice. Two raw POSTs rather than the SDK
 * client, whose extra requests (`notifications/initialized` at least) would reach
 * the same context and add `waitUntil` entries the suites count.
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
  const send = async <T>(id: number, method: string, params: unknown): Promise<T> => {
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
    // The stateless 2025 transport always answers as a one-event SSE stream.
    const data = text.split('\n').find((line) => line.startsWith('data: '))
    const message = data ? (JSON.parse(data.slice('data: '.length)) as { result?: T }) : {}
    if (message.result === undefined) {
      throw new Error(`${method} answered no JSON-RPC result: ${text}`)
    }
    return message.result
  }

  await send(1, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 't', version: '1' },
  })
  return send<SeamToolResult>(2, 'tools/call', { name: call.tool, arguments: call.arguments ?? {} })
}

/** The context shape workerd hands `fetch`, with `waitUntil` collecting instead of running. */
export function recordingExecutionContext(deferred: Promise<unknown>[]): unknown {
  return {
    waitUntil: (work: Promise<unknown>) => void deferred.push(work),
    passThroughOnException: () => {},
    props: {},
  }
}
