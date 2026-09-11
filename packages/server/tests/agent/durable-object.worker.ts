// Worker entry for durable-object.workerd.test.ts — bundled with Bun.build at
// test time and executed inside workerd. Both side channels are built the way
// @guren/plugin-agents' tool client builds them, with no deferrer, then started
// from each Durable Object entry point and, as the control, a fetch handler.

// @ts-expect-error -- workerd supplies this module; the root program carries no Workers types.
import { DurableObject } from 'cloudflare:workers'

import type { AgentApprovalStore } from '../../src/agent/approval'
import { buildAgentApprovalRequest } from '../../src/agent/approval'
import { createAuditEmitter } from '../../src/agent/audit-emitter'
import { AgentToolInvoked } from '../../src/agent/events'
import { createAgentApprovalContext } from '../../src/agent/pipeline'

interface D1 {
  prepare: (sql: string) => { bind: (...values: unknown[]) => { run: () => Promise<unknown> } }
}

/** Bun's `WebSocket` type has no `accept`, which a workerd socket needs before use. */
interface WorkerdSocket extends WebSocket {
  accept(): void
}

declare const WebSocketPair: new () => { 0: WorkerdSocket; 1: WorkerdSocket }

interface ProbeState {
  storage: { setAlarm(at: number): Promise<void> }
  acceptWebSocket(socket: WorkerdSocket): void
}

interface ProbeStub {
  fetch(input: string, init?: RequestInit): Promise<Response>
  enter(): Promise<void>
  arm(): Promise<void>
}

interface Env {
  DB: D1
  PROBE: { idFromName(name: string): unknown; get(id: unknown): ProbeStub }
}

const principal = { kind: 'service' as const, id: 'agent:probe:instance', abilities: [] }

/** Neither channel is awaited nor deferred, as in a tool call's handler. */
function startChannels(db: D1, via: string): void {
  const land = async (row: string): Promise<void> => {
    // Still in flight when the handler returns: a D1 write or a webhook round
    // trip is this, the round trip being the delay.
    await new Promise((done) => setTimeout(done, 50))
    await db.prepare('INSERT INTO landed (tool) VALUES (?)').bind(row).run()
  }

  createAuditEmitter((record) => land(`audit:${record.tool}`), undefined)(
    new AgentToolInvoked(principal, via, {}, 200, 1, 'durable'),
  )

  const approvals = createAgentApprovalContext(
    // Never read: only `notify` runs here.
    { store: {} as AgentApprovalStore, notify: (request) => land(`notify:${request.tool}`) },
    principal,
  )
  approvals?.notify(
    buildAgentApprovalRequest({ tool: via, input: {}, fingerprint: 'fp', principal }, new Date()),
  )
}

export class ProbeObject extends DurableObject {
  declare readonly ctx: ProbeState
  declare readonly env: Env

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') === 'websocket') {
      const pair = new WebSocketPair()
      this.ctx.acceptWebSocket(pair[1])
      return new Response(null, { status: 101, webSocket: pair[0] } as ResponseInit)
    }
    startChannels(this.env.DB, 'fetch')
    return new Response('ok')
  }

  async enter(): Promise<void> {
    startChannels(this.env.DB, 'rpc')
  }

  async arm(): Promise<void> {
    await this.ctx.storage.setAlarm(Date.now())
  }

  async alarm(): Promise<void> {
    startChannels(this.env.DB, 'alarm')
  }

  async webSocketMessage(socket: WorkerdSocket): Promise<void> {
    startChannels(this.env.DB, 'websocket')
    socket.send('started')
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const via = new URL(request.url).searchParams.get('tool') ?? 'unknown'
    // One instance per case, so no later dispatch is what keeps it alive.
    const stub = env.PROBE.get(env.PROBE.idFromName(via))

    switch (via) {
      case 'handler':
        startChannels(env.DB, via)
        break
      case 'fetch':
        await (await stub.fetch(request.url)).arrayBuffer()
        break
      case 'rpc':
        await stub.enter()
        break
      case 'alarm':
        await stub.arm()
        break
      case 'websocket':
        await converse(stub, request.url)
        break
      default:
        return new Response(`unknown entry point ${via}`, { status: 400 })
    }
    return new Response('ok')
  },
}

/** The client half runs in workerd: Bun's `ws` shim cannot complete Miniflare's upgrade. */
async function converse(stub: ProbeStub, url: string): Promise<void> {
  const upgraded = await stub.fetch(url, { headers: { Upgrade: 'websocket' } })
  const socket = (upgraded as Response & { webSocket: WorkerdSocket | null }).webSocket
  if (!socket) throw new Error(`the Durable Object answered ${upgraded.status} without a socket`)
  socket.accept()
  const reply = new Promise((done) => socket.addEventListener('message', done, { once: true }))
  socket.send('go')
  await reply
  socket.close(1000, 'done')
}
