import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'

/** Where the Dev MCP endpoint answers; the host only has to parse as a URL. */
export const DEV_MCP_ENDPOINT = 'http://127.0.0.1:3333/_guren/mcp'

/** The `{ server }` env Bun.serve passes through Hono, so the loopback guard sees a local peer. */
export const LOOPBACK_ENV = { server: { requestIP: () => ({ address: '127.0.0.1' }) } }

export type ProtocolEra = 'modern' | 'legacy'

/**
 * A client pinned to one protocol era, talking to `serve` in-process. `modern`
 * pins 2026-07-28 so a server that only speaks the 2025 protocol fails the
 * connection instead of quietly negotiating its way down to it.
 */
export async function connectDevMcpClient(
  serve: (request: Request) => Promise<Response>,
  era: ProtocolEra,
): Promise<Client> {
  const client = new Client(
    { name: 'dev-mcp-test', version: '1.0.0' },
    era === 'modern' ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {},
  )

  await client.connect(
    new StreamableHTTPClientTransport(new URL(DEV_MCP_ENDPOINT), {
      fetch: (url, init) => serve(new Request(url, init)),
    }),
  )

  return client
}

/** The first text block of a tool result, which is where every Dev MCP tool puts its answer. */
export function toolText(result: { content: unknown }): string {
  const [first] = result.content as Array<{ type: string; text?: string }>
  return first?.text ?? ''
}
