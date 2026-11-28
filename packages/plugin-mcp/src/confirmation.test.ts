/**
 * Confirmation over the endpoint (RFC 0042 §2.3, §2.4), driven by the SDK client
 * against a booted application: what is under test is the round trip a host makes,
 * and a hand-built `input_required` exchange would only restate the handler.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test, type Mock } from 'bun:test'
import { Client, StreamableHTTPClientTransport, withInputRequired } from '@modelcontextprotocol/client'
import {
  Controller,
  EventServiceProvider,
  MemoryApiTokenStore,
  createApiToken,
  createApp,
  type AgentConfirmationRequest,
} from '@guren/core'
import { z } from 'zod'

import { confirmationKeyFromEnv, describeConfirmation } from './confirmation'
import { mcpPlugin, type McpPluginConfig } from './plugin'

const APP_KEY = 'base64:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='
const INVALID_PARAMS = -32602
const CALL = { name: 'posts_archive', arguments: { id: 5, reason: 'outdated' } }
const YES = { confirm: { action: 'accept', content: { confirm: true } } }

type Answer = { action: 'accept' | 'decline' | 'cancel'; content?: Record<string, boolean> }

interface ConnectOptions {
  era?: 'modern' | 'legacy'
  /** How the client's elicitation handler answers; absent, the client declares no elicitation. */
  answer?: Answer
  capabilities?: Record<string, unknown>
  /** Hand `input_required` back to the caller instead of answering it. */
  manual?: boolean
  token?: string
}

interface Harness {
  archived: number[]
  audit: string[]
  tokens: { caller: string; stranger: string }
  connect(options?: ConnectOptions): Promise<{ client: Client; asked: string[] }>
}

async function boot(config: McpPluginConfig = {}): Promise<Harness> {
  const archived: number[] = []
  const audit: string[] = []

  class PostController extends Controller {
    async archive() {
      const { id } = this.validateParams(z.object({ id: z.coerce.number() }))
      archived.push(id)
      return this.json({ archived: id })
    }
  }

  const store = new MemoryApiTokenStore()
  const app = createApp({
    routes: (router) => {
      router
        .post('/posts/:id/archive', { body: z.object({ reason: z.string().min(3) }) }, [PostController, 'archive'])
        .name('posts.archive')
        .agent({ toolName: 'posts_archive', confirm: { message: 'This hides the post from readers.' }, redact: ['reason'] })
    },
    providers: [
      EventServiceProvider,
      mcpPlugin({
        ...config,
        audit: { sink: (record) => void audit.push(`${record.outcome}:${'reason' in record ? record.reason : record.status}`) },
      }),
    ],
  })
  app.auth.useTokens(store)
  await app.boot()
  const issue = async (userId: number): Promise<string> =>
    (await createApiToken(store, { name: `user-${userId}`, userId, abilities: ['tools:*'] })).plainTextToken
  const tokens = { caller: await issue(1), stranger: await issue(2) }

  return {
    archived,
    audit,
    tokens,
    async connect(options = {}) {
      const transport = new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
        fetch: (input, init) => app.fetch(new Request(input, init)),
        requestInit: { headers: { Authorization: `Bearer ${options.token ?? tokens.caller}` } },
      })
      const asked: string[] = []
      const client = new Client(
        { name: 'confirmation', version: '1.0.0' },
        {
          capabilities: options.capabilities ?? (options.answer || options.manual ? { elicitation: { form: {} } } : {}),
          ...((options.era ?? 'modern') === 'modern' ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {}),
          ...(options.manual ? { inputRequired: { autoFulfill: false } } : {}),
        },
      )
      const { answer } = options
      if (answer) {
        client.setRequestHandler('elicitation/create', (request) => {
          asked.push(request.params.message)
          return answer
        })
      }
      await client.connect(transport)
      return { client, asked }
    },
  }
}

const textOf = (result: { content?: unknown }): string =>
  (result.content as Array<{ text: string }>).map((block) => block.text).join('\n')

interface Held {
  resultType?: string
  requestState?: string
  content?: unknown
  thrown?: number
}

/** One `tools/call` leg in manual mode: the `input_required` result, the tool result, or the protocol error's code. */
function leg(client: Client, params: Record<string, unknown>): Promise<Held> {
  return client
    .request({ method: 'tools/call', params } as never, withInputRequired(z.looseObject({})), { allowInputRequired: true })
    .then((result) => result as Held)
    .catch((error: unknown) => ({ thrown: (error as { code?: number }).code }))
}

describe('a confirm tool over the MCP endpoint', () => {
  let previousKey: string | undefined

  beforeEach(() => {
    previousKey = process.env.APP_KEY
    process.env.APP_KEY = APP_KEY
  })

  afterEach(() => {
    if (previousKey === undefined) delete process.env.APP_KEY
    else process.env.APP_KEY = previousKey
  })

  test('should ask with the message and the redacted arguments, then run the action once the caller agrees', async () => {
    const h = await boot()
    const { client, asked } = await h.connect({ answer: { action: 'accept', content: { confirm: true } } })

    const result = await client.callTool(CALL)

    expect(result.isError).toBeUndefined()
    expect(textOf(result)).toBe('{"archived":5}')
    expect(asked).toEqual(['This hides the post from readers.\n\nTool: posts_archive\nArguments: {"id":5,"reason":"[REDACTED]"}'])
    expect(h.archived).toEqual([5])
    expect(h.audit).toEqual(['denied:confirmation', 'invoked:200'])
  })

  test('should end the call as a confirmation denial when the form is declined, cancelled or returned unticked', async () => {
    const answers: Answer[] = [{ action: 'decline' }, { action: 'cancel' }, { action: 'accept', content: { confirm: false } }]
    for (const answer of answers) {
      const h = await boot()
      const { client } = await h.connect({ answer })

      const result = await client.callTool(CALL)

      expect(result.isError).toBe(true)
      expect(textOf(result)).toBe('The calling user did not confirm "posts_archive". Nothing was executed.')
      expect(h.archived).toEqual([])
      // The question, then the refusal of its answer.
      expect(h.audit).toEqual(['denied:confirmation', 'denied:confirmation'])
    }
  })

  test('should meter a declined answer, which the pipeline never sees', async () => {
    const h = await boot({ rateLimit: { max: 1 } })
    const { client } = await h.connect({ answer: { action: 'decline' } })

    const result = await client.callTool(CALL)

    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('Rate limit exceeded')
    // The question spent the one call of the window; the answer found none left.
    expect(h.audit).toEqual(['denied:confirmation', 'denied:rate-limit'])
  })

  test('should answer a call the route refuses with its validation errors, asking nobody', async () => {
    const h = await boot()
    const { client, asked } = await h.connect({ answer: { action: 'accept', content: { confirm: true } } })

    const result = await client.callTool({ name: 'posts_archive', arguments: { id: 5, reason: 'no' } })

    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('The given data was invalid.')
    expect(asked).toEqual([])
    expect(h.archived).toEqual([])
  })

  test('should refuse a client that declares no form elicitation, naming the capability', async () => {
    for (const capabilities of [{}, { elicitation: { url: {} } }]) {
      const h = await boot()
      const { client } = await h.connect({ capabilities })

      const result = await client.callTool(CALL)

      expect(result.isError).toBe(true)
      expect(textOf(result)).toContain('did not declare form elicitation (capabilities.elicitation)')
      expect(h.archived).toEqual([])
      expect(h.audit).toEqual(['denied:confirmation'])
    }
  })

  test('should ask a client that declares elicitation with no mode, which means forms', async () => {
    const h = await boot()
    const { client, asked } = await h.connect({ capabilities: { elicitation: {} }, answer: { action: 'accept', content: { confirm: true } } })

    await client.callTool(CALL)

    expect(asked).toHaveLength(1)
    expect(h.archived).toEqual([5])
  })

  test('should refuse every request on the 2025 era, naming the protocol version', async () => {
    const h = await boot()
    const { client, asked } = await h.connect({ era: 'legacy', answer: { action: 'accept', content: { confirm: true } } })

    const result = await client.callTool(CALL)

    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('can ask only on MCP 2026-07-28')
    expect(asked).toEqual([])
    expect(h.archived).toEqual([])
  })

  test('should keep the tool listed for a client it would refuse', async () => {
    const h = await boot()
    const { client } = await h.connect({ era: 'legacy' })

    const { tools } = await client.listTools()

    expect(tools.map((tool) => tool.name)).toContain('posts_archive')
  })

  test('should ask again, running nothing, when the retry carries other arguments than the caller agreed to', async () => {
    const h = await boot()
    const { client } = await h.connect({ manual: true })
    const first = await leg(client, CALL)
    expect(first.resultType).toBe('input_required')

    const changed = await leg(client, {
      name: 'posts_archive',
      arguments: { id: 6, reason: 'outdated' },
      inputResponses: YES,
      requestState: first.requestState,
    })

    expect(changed.resultType).toBe('input_required')
    expect(changed.requestState).not.toBe(first.requestState)
    expect(h.archived).toEqual([])
  })

  test('should run the call the state names when the same arguments come back with the answer', async () => {
    const h = await boot()
    const { client } = await h.connect({ manual: true })
    const first = await leg(client, CALL)

    const confirmed = await leg(client, { ...CALL, inputResponses: YES, requestState: first.requestState })

    expect(confirmed.content).toEqual([{ type: 'text', text: '{"archived":5}' }])
    expect(h.archived).toEqual([5])
  })

  test('should ask again when the state comes back with no answer', async () => {
    const h = await boot()
    const { client } = await h.connect({ manual: true })
    const first = await leg(client, CALL)

    const unanswered = await leg(client, { ...CALL, requestState: first.requestState })

    expect(unanswered.resultType).toBe('input_required')
    expect(h.archived).toEqual([])
  })

  test('should reject a state that was altered, before any tool is resolved', async () => {
    const h = await boot()
    const { client } = await h.connect({ manual: true })
    const first = await leg(client, CALL)
    const recorded = h.audit.length

    const tampered = await leg(client, { ...CALL, inputResponses: YES, requestState: `${first.requestState}x` })

    expect(tampered.thrown).toBe(INVALID_PARAMS)
    expect(h.archived).toEqual([])
    expect(h.audit).toHaveLength(recorded)
  })

  test('should reject a state minted for another caller', async () => {
    const h = await boot()
    const { client } = await h.connect({ manual: true })
    const { client: stranger } = await h.connect({ manual: true, token: h.tokens.stranger })
    const first = await leg(client, CALL)

    const stolen = await leg(stranger, { ...CALL, inputResponses: YES, requestState: first.requestState })

    expect(stolen.thrown).toBe(INVALID_PARAMS)
    expect(h.archived).toEqual([])
  })

  test('should report the confirmation a real call waits for in a rehearsal, without asking', async () => {
    const h = await boot()
    const { client, asked } = await h.connect({ answer: { action: 'accept', content: { confirm: true } } })

    const result = await client.callTool({ name: 'guren_preflight', arguments: { tool: 'posts_archive', input: CALL.arguments } })

    expect(result.structuredContent).toMatchObject({ tool: 'posts_archive', allowed: true, confirmation: 'required' })
    expect(asked).toEqual([])
    expect(h.archived).toEqual([])
  })
})

describe('a confirm tool on an app with no APP_KEY', () => {
  let previousKey: string | undefined
  let warn: Mock<typeof console.warn>

  beforeEach(() => {
    previousKey = process.env.APP_KEY
    delete process.env.APP_KEY
    warn = spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    if (previousKey !== undefined) process.env.APP_KEY = previousKey
    warn.mockRestore()
  })

  test('should warn at boot and refuse the call, since the question could not be signed', async () => {
    const h = await boot()
    const { client, asked } = await h.connect({ answer: { action: 'accept', content: { confirm: true } } })

    const result = await client.callTool(CALL)

    expect(warn.mock.calls.flat().join('\n')).toContain('so every call to "posts_archive" is refused')
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('This server has no APP_KEY to sign the question with')
    expect(asked).toEqual([])
    expect(h.archived).toEqual([])
  })
})

describe('describeConfirmation', () => {
  const request: AgentConfirmationRequest = { tool: 'posts_archive', message: 'Run "posts_archive"?', input: { id: 5 }, fingerprint: 'f' }

  test('should put the message first and the arguments after it', () => {
    expect(describeConfirmation(request)).toBe('Run "posts_archive"?\n\nTool: posts_archive\nArguments: {"id":5}')
  })

  test('should bound the arguments it shows', () => {
    const shown = describeConfirmation({ ...request, input: { body: 'x'.repeat(5000) } })

    expect(shown.length).toBeLessThan(1100)
    expect(shown).toEndWith('… (truncated)')
  })
})

describe('confirmationKeyFromEnv', () => {
  test('should derive a key apart from the application key, and none without a valid one', () => {
    const key = confirmationKeyFromEnv({ APP_KEY })

    expect(key).toHaveLength(32)
    expect(Buffer.from(key!).toString('base64')).not.toBe(APP_KEY.slice('base64:'.length))
    expect(confirmationKeyFromEnv({})).toBeUndefined()
    expect(confirmationKeyFromEnv({ APP_KEY: 'not-a-key' })).toBeUndefined()
  })
})
