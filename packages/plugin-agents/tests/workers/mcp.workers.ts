/// <reference types="@cloudflare/vitest-plugin/types" />
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

/**
 * The App MCP endpoint answering inside workerd (RFC 0028 §5), from the worker
 * `guren cloudflare:build` generated. SDK v2's server picks its `workerd` shims at
 * runtime and reaches the factory by a different path for each protocol era, so
 * each era is driven here rather than trusting the Bun suite to stand in for it.
 */

const ENDPOINT = 'https://fixture.test/mcp'

async function connect(era: 'modern' | 'legacy'): Promise<Client> {
  const minted = await SELF.fetch('https://fixture.test/__probe/mcp-token')
  expect(minted.status).toBe(200)
  const { token } = (await minted.json()) as { token: string }

  const client = new Client(
    { name: `workerd-${era}`, version: '1.0.0' },
    era === 'modern' ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {},
  )
  await client.connect(
    new StreamableHTTPClientTransport(new URL(ENDPOINT), {
      fetch: (input, init) => SELF.fetch(input, init),
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  )
  return client
}

describe.each(['modern', 'legacy'] as const)('App MCP over a %s client', (era) => {
  it('should negotiate the era it asked for', async () => {
    const client = await connect(era)

    expect(client.getProtocolEra()).toBe(era)

    await client.close()
  })

  it('should list the tools the token reaches and call one through the app', async () => {
    const client = await connect(era)

    const { tools } = await client.listTools()
    expect(tools.map((tool) => tool.name)).toContain('posts.index')
    expect(tools.map((tool) => tool.name)).not.toContain('posts.store')

    const result = await client.callTool({ name: 'posts.index', arguments: {} })
    const [first] = result.content as Array<{ text?: string }>
    expect(JSON.parse(first?.text ?? '')).toEqual({ posts: [{ id: 1, title: 'Hello' }] })

    await client.close()
  })
})
