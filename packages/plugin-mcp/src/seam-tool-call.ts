/**
 * One `tools/call` over the external-auth seam, dispatched with the execution
 * context the Workers runtime would pass. Shared by the two deferral suites
 * because it is this package's only description of how a request crosses that
 * seam holding one: the protocol version, the header set and the seam's
 * principal are pinned here rather than twice. The SDK client is not used — it
 * owns the `fetch` it calls, and the third `app.fetch` argument is the point.
 */
import type { Application } from '@guren/core'

import { presentExternalMcpAuth } from './external-auth'

export interface SeamToolCall {
  tool: string
  arguments?: Record<string, unknown>
  /** Omitted, the endpoint sees no context — which is every runtime but Workers. */
  executionCtx?: unknown
}

export async function callToolOverSeam(app: Application, call: SeamToolCall): Promise<void> {
  const post = (body: unknown): Request =>
    presentExternalMcpAuth(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify(body),
      }),
      { principal: { kind: 'user', id: 'u_1', abilities: ['tools:*'] }, scopes: ['tools:*'] },
    )

  const send = async (body: unknown): Promise<void> => {
    const response = await app.fetch(post(body), undefined, call.executionCtx as never)
    await response.arrayBuffer()
  }

  await send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } },
  })
  await send({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: call.tool, arguments: call.arguments ?? {} },
  })
}

/** The context shape workerd hands `fetch`, with `waitUntil` collecting instead of running. */
export function recordingExecutionContext(deferred: Promise<unknown>[]): unknown {
  return {
    waitUntil: (work: Promise<unknown>) => void deferred.push(work),
    passThroughOnException: () => {},
    props: {},
  }
}
