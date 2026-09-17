process.env.APP_KEY = 'base64:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { DrizzleAdapter, createApp, type AgentPrincipal } from '@guren/core'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

import { Agent, DatabaseConversationStore, MemoryConversationStore, agent, defineAiConfig, tool } from '../src'
import { bootHarness, scriptedModel } from './fixture'
import { z } from 'zod'

class Support extends Agent {
  static override agentName = 'support'
  instructions = 'Help.'
}

class Billing extends Agent {
  static override agentName = 'billing'
  instructions = 'Bill.'
}

const USER: AgentPrincipal = { kind: 'user', id: 1 }

describe('conversations through prompt() and continue()', () => {
  test('should store nothing and return no id when no conversation is asked for', async () => {
    const h = await bootHarness({ conversations: { driver: 'memory' } })
    h.script([{ text: 'one-off' }])

    const response = await h.app.container.make('ai').agent(Support).as(USER).prompt('Hi')

    expect(response.conversationId).toBeUndefined()
  })

  test('should replay every earlier turn, in order, into the next prompt', async () => {
    const h = await bootHarness({ conversations: { driver: 'memory' } })
    const model = h.script([{ text: 'first answer' }, { text: 'second answer' }, { text: 'third answer' }])
    const support = h.app.container.make('ai').agent(Support).as(USER)

    const first = await support.prompt('first question', { conversation: true })
    const id = first.conversationId!
    const second = await support.continue(id).prompt('second question')
    await support.prompt('third question', { conversation: id })

    expect(second.conversationId).toBe(id)
    expect(model.doGenerateCalls[0]!.prompt.slice(1)).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'first question' }], providerOptions: undefined },
    ])
    expect(model.doGenerateCalls[2]!.prompt.slice(1).map((message) => [message.role, textOf(message.content)])).toEqual([
      ['user', 'first question'],
      ['assistant', 'first answer'],
      ['user', 'second question'],
      ['assistant', 'second answer'],
      ['user', 'third question'],
    ])
  })

  test('should replay a tool call together with its result', async () => {
    class Lookup extends Agent {
      static override agentName = 'lookup'
      instructions = 'Look it up.'
      override tools() {
        return { order: tool({ inputSchema: z.object({ id: z.number() }), execute: async ({ id }) => ({ id, status: 'shipped' }) }) }
      }
    }
    const h = await bootHarness({ conversations: { driver: 'memory' } })
    const model = h.script([
      { toolCalls: [{ name: 'order', input: { id: 7 } }] },
      { text: 'It shipped.' },
      { text: 'Order 7, as above.' },
    ])
    const lookup = h.app.container.make('ai').agent(Lookup).as(USER)

    const first = await lookup.prompt('Where is order 7?', { conversation: true })
    await lookup.continue(first.conversationId!).prompt('Which order was that?')

    const replayed = model.doGenerateCalls[2]!.prompt.slice(1)
    expect(replayed.map((message) => message.role)).toEqual(['user', 'assistant', 'tool', 'assistant', 'user'])
    expect(replayed[2]!.content).toEqual([
      expect.objectContaining({ type: 'tool-result', toolName: 'order', output: { type: 'json', value: { id: 7, status: 'shipped' } } }),
    ])
  })

  test('should refuse a conversation under as(null) before any model call', async () => {
    const h = await bootHarness({ conversations: { driver: 'memory' } })
    const model = h.script([{ text: 'never' }])

    await expect(h.app.container.make('ai').agent(Support).as(null).prompt('Hi', { conversation: true }))
      .rejects.toThrow('support was asked for a conversation under as(null).')
    expect(model.doGenerateCalls).toHaveLength(0)
  })

  test('should refuse another principal, telling 5 from "5", before any model call', async () => {
    const h = await bootHarness({ conversations: { driver: 'memory' } })
    const model = h.script([{ text: 'mine' }])
    const ai = h.app.container.make('ai')
    const { conversationId } = await ai.agent(Support).as({ id: 5 }).prompt('Hi', { conversation: true })

    for (const other of [{ id: '5' }, { id: 6 }, { id: 5, kind: 'service' as const }]) {
      await expect(ai.agent(Support).as(other).continue(conversationId!).prompt('Hi'))
        .rejects.toThrow(`support cannot continue conversation "${conversationId}": no conversation with that id belongs to this principal.`)
    }
    expect(model.doGenerateCalls).toHaveLength(1)
  })

  test('should refuse to continue a conversation another agent started', async () => {
    const h = await bootHarness({ conversations: { driver: 'memory' } })
    h.script([{ text: 'support answer' }])
    const ai = h.app.container.make('ai')
    const { conversationId } = await ai.agent(Support).as(USER).prompt('Hi', { conversation: true })

    await expect(ai.agent(Billing).as(USER).continue(conversationId!).prompt('Hi'))
      .rejects.toThrow(`billing cannot continue conversation "${conversationId}", which support started.`)
  })

  test('should explain the missing store when config/ai.ts configures none', async () => {
    const h = await bootHarness()

    await expect(h.app.container.make('ai').agent(Support).as(USER).prompt('Hi', { conversation: true }))
      .rejects.toThrow('config/ai.ts configures no conversation store.')
  })

  test('should fail the boot on a conversation driver nothing registered', async () => {
    const app = createApp({
      config: [defineAiConfig(() => ({
        default: 'main',
        providers: { main: { model: () => scriptedModel([]) } },
        conversations: { driver: 'agentcore' } as never,
      }))],
    })

    await expect(app.boot()).rejects.toThrow('config/ai.ts names the conversation driver "agentcore". The drivers are: memory, database.')
  })

  test('should fail the boot on a database driver missing a table', async () => {
    const app = createApp({
      config: [defineAiConfig(() => ({
        default: 'main',
        providers: { main: { model: () => scriptedModel([]) } },
        conversations: { driver: 'database', conversations: undefined, messages: undefined },
      }))],
    })

    await expect(app.boot()).rejects.toThrow('The database conversation driver needs both tables')
  })

  test('should refuse a conversation with an agent() that has no agentName', async () => {
    const h = await bootHarness({ conversations: { driver: 'memory' } })
    const model = h.script([{ text: 'never' }])

    await expect(h.app.container.make('ai').agent(agent({ instructions: 'x' })).as(USER).prompt('Hi', { conversation: true }))
      .rejects.toThrow('Pass agent({ agentName }) to keep conversations with it.')
    expect(model.doGenerateCalls).toHaveLength(0)
  })

  test('should refuse a prompt option naming a different conversation than continue() bound', async () => {
    const h = await bootHarness({ conversations: { driver: 'memory' } })
    const model = h.script([{ text: 'first' }])
    const support = h.app.container.make('ai').agent(Support).as(USER)
    const { conversationId } = await support.prompt('Hi', { conversation: true })

    await expect(support.continue(conversationId!).prompt('again', { conversation: true }))
      .rejects.toThrow(`support is bound to conversation "${conversationId}" by continue(), and this prompt asks for a new one.`)
    expect(model.doGenerateCalls).toHaveLength(1)
  })
})

describe('MemoryConversationStore', () => {
  test('should keep its history from a caller mutating what it loaded or appended', async () => {
    const store = new MemoryConversationStore()
    const id = await store.create({ agentName: 'support', owner: USER, messages: [] })
    const message = { role: 'user' as const, content: 'original' }
    await store.append(id, USER, [message])

    message.content = 'changed'
    const loaded = await store.load(id, USER)
    ;(loaded!.messages[0] as { content: string }).content = 'changed too'

    expect((await store.load(id, USER))!.messages).toEqual([{ role: 'user', content: 'original' }])
  })
})

const conversations = sqliteTable('ai_conversations', {
  id: text('id').primaryKey(),
  agentName: text('agent_name').notNull(),
  owner: text('owner').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
})

const messageColumns = {
  id: text('id').primaryKey(),
  conversationId: text('conversation_id').notNull(),
  position: integer('position').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
}

const messages = sqliteTable('ai_messages', {
  ...messageColumns,
  message: text('message', { mode: 'json' }).notNull(),
}, (table) => [uniqueIndex('ai_messages_position').on(table.conversationId, table.position)])

const messagesText = sqliteTable('ai_messages_text', {
  ...messageColumns,
  message: text('message').notNull(),
}, (table) => [uniqueIndex('ai_messages_text_position').on(table.conversationId, table.position)])

describe('DatabaseConversationStore', () => {
  let sqlite: Database

  beforeEach(() => {
    sqlite = new Database(':memory:')
    sqlite.exec(`
      CREATE TABLE ai_conversations (id text primary key, agent_name text not null, owner text not null, created_at integer not null, updated_at integer not null);
    `)
    for (const name of ['ai_messages', 'ai_messages_text']) {
      sqlite.exec(`
        CREATE TABLE ${name} (id text primary key, conversation_id text not null, position integer not null, message text not null, created_at integer not null);
        CREATE UNIQUE INDEX ${name}_position ON ${name} (conversation_id, position);
      `)
    }
    DrizzleAdapter.configure(drizzle({ client: sqlite }) as never)
  })

  afterEach(() => {
    sqlite.close()
  })

  for (const [mode, table] of [['json', messages], ['text', messagesText]] as const) {
    test(`should load appended messages in position order across appends (${mode} column)`, async () => {
      const store = new DatabaseConversationStore({ conversations, messages: table, dataMode: mode })
      const id = await store.create({ agentName: 'support', owner: USER, messages: [] })

      await store.append(id, USER, [{ role: 'user', content: 'one' }, { role: 'assistant', content: 'two' }])
      await store.append(id, USER, [{ role: 'user', content: 'three' }, { role: 'assistant', content: 'four' }])

      expect(await store.load(id, USER)).toEqual({
        agentName: 'support',
        messages: [
          { role: 'user', content: 'one' },
          { role: 'assistant', content: 'two' },
          { role: 'user', content: 'three' },
          { role: 'assistant', content: 'four' },
        ],
      })
    })
  }

  test('should answer null for another owner, and refuse its append without writing', async () => {
    const store = new DatabaseConversationStore({ conversations, messages })
    const id = await store.create({ agentName: 'support', owner: USER, messages: [] })
    const intruder: AgentPrincipal = { kind: 'user', id: '1' }

    expect(await store.load(id, intruder)).toBeNull()
    await expect(store.append(id, intruder, [{ role: 'user', content: 'x' }])).rejects.toThrow(`No conversation "${id}" belongs to this principal.`)
    expect(sqlite.query('select count(*) as n from ai_messages').get()).toEqual({ n: 0 })
  })

  test('should leave no conversation when its first messages fail to store', async () => {
    const store = new DatabaseConversationStore({ conversations, messages })

    await expect(store.create({
      agentName: 'support',
      owner: USER,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'x', providerOptions: { bad: { n: 1n } } as never }] }],
    })).rejects.toThrow()

    expect(sqlite.query('select count(*) as n from ai_conversations').get()).toEqual({ n: 0 })
  })

  test('should write none of an append whose later message fails to store', async () => {
    const store = new DatabaseConversationStore({ conversations, messages })
    const id = await store.create({ agentName: 'support', owner: USER, messages: [] })

    await expect(store.append(id, USER, [
      { role: 'user', content: 'stored first' },
      { role: 'user', content: [{ type: 'text', text: 'x', providerOptions: { bad: { n: 1n } } as never }] },
    ])).rejects.toThrow()

    expect(sqlite.query('select count(*) as n from ai_messages').get()).toEqual({ n: 0 })
  })

  test('should store binary file data as base64, which replays as the same bytes', async () => {
    const store = new DatabaseConversationStore({ conversations, messages })
    const id = await store.create({ agentName: 'support', owner: USER, messages: [] })

    await store.append(id, USER, [{
      role: 'assistant',
      content: [{ type: 'file', mediaType: 'image/png', data: new Uint8Array([137, 80, 78, 71]) }],
    }])

    const [message] = (await store.load(id, USER))!.messages
    expect(message!.content).toEqual([{ type: 'file', mediaType: 'image/png', data: 'iVBORw==' }])
  })

  test('should create a conversation only once the first prompt has an answer', async () => {
    const h = await bootHarness({ conversations: { driver: 'database', conversations, messages } })
    const model = h.script([])
    model.doGenerate = async () => {
      throw new Error('provider down')
    }
    DrizzleAdapter.configure(drizzle({ client: sqlite }) as never)

    await expect(h.app.container.make('ai').agent(Support).as(USER).prompt('Hi', { conversation: true }))
      .rejects.toThrow('provider down')
    expect(sqlite.query('select count(*) as n from ai_conversations').get()).toEqual({ n: 0 })
  })
})

function textOf(content: unknown): string {
  return Array.isArray(content) ? content.map((part: { text?: string }) => part.text ?? '').join('') : String(content)
}
