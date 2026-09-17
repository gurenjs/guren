/**
 * Conversation stores (RFC 0029 §5): replay history in the AI SDK's `ModelMessage`
 * shape, one record per message, keyed by the principal that started it. The store
 * is the only owner check a conversation gets, since no route or policy runs.
 */
import { agentApprovalPrincipalKey, Model, type AgentPrincipal } from '@guren/core'
import { convertDataContentToBase64String, type ModelMessage } from 'ai'

export interface StoredConversation {
  agentName: string
  messages: ModelMessage[]
}

export interface ConversationStore {
  /** Stores the conversation with its first messages, all or none, and returns its id. */
  create(meta: { agentName: string; owner: AgentPrincipal; messages: readonly ModelMessage[] }): Promise<string>
  /** `null` for an unknown id and for another owner's conversation alike, so ids cannot be probed. */
  load(id: string, owner: AgentPrincipal): Promise<StoredConversation | null>
  /** Appends after the stored messages, all or none. Refuses an id `owner` does not own. */
  append(id: string, owner: AgentPrincipal, messages: readonly ModelMessage[]): Promise<void>
}

/** Driver name to its options in `config/ai.ts`. */
export interface ConversationDrivers {
  // oxlint-disable-next-line typescript/no-empty-object-type -- a driver that takes no options
  memory: {}
  database: {
    /** Column properties `id` (text primary key), `agentName`, `owner`, `createdAt`, `updatedAt`. */
    conversations: unknown
    /**
     * Column properties `id` (text primary key), `conversationId`, `position`, `message`, `createdAt`,
     * with a unique index on (`conversationId`, `position`).
     */
    messages: unknown
    /** `'json'` (default) passes each message to a JSON column; `'text'` stores a JSON string. */
    dataMode?: 'json' | 'text'
  }
}

export type ConversationsConfig = {
  [K in keyof ConversationDrivers]: { driver: K } & ConversationDrivers[K]
}[keyof ConversationDrivers]

export function createConversationStore(config: ConversationsConfig): ConversationStore {
  switch (config.driver) {
    case 'memory':
      return new MemoryConversationStore()
    case 'database':
      return new DatabaseConversationStore(config)
  }
  throw new Error(
    `config/ai.ts names the conversation driver "${(config as { driver: string }).driver}". `
    + 'The drivers are: memory, database.',
  )
}

interface MemoryConversation extends StoredConversation {
  owner: string
}

/** Per process, lost on restart: tests and development. */
export class MemoryConversationStore implements ConversationStore {
  private readonly conversations = new Map<string, MemoryConversation>()

  async create(meta: { agentName: string; owner: AgentPrincipal; messages: readonly ModelMessage[] }): Promise<string> {
    const id = crypto.randomUUID()
    this.conversations.set(id, {
      agentName: meta.agentName,
      owner: agentApprovalPrincipalKey(meta.owner),
      messages: storableMessages(meta.messages),
    })
    return id
  }

  async load(id: string, owner: AgentPrincipal): Promise<StoredConversation | null> {
    const conversation = this.owned(id, owner)
    // Copied out and in, so a caller mutating a message cannot rewrite the history.
    return conversation ? { agentName: conversation.agentName, messages: storableMessages(conversation.messages) } : null
  }

  async append(id: string, owner: AgentPrincipal, messages: readonly ModelMessage[]): Promise<void> {
    const conversation = this.owned(id, owner)
    if (!conversation) throw unknownConversation(id)
    conversation.messages.push(...storableMessages(messages))
  }

  private owned(id: string, owner: AgentPrincipal): MemoryConversation | null {
    const conversation = this.conversations.get(id)
    return conversation?.owner === agentApprovalPrincipalKey(owner) ? conversation : null
  }
}

/** The `ai_conversations` / `ai_messages` tables `guren add ai` scaffolds, through ORM Models. */
export class DatabaseConversationStore implements ConversationStore {
  private readonly conversations: typeof Model
  private readonly messages: typeof Model
  private readonly dataMode: 'json' | 'text'

  constructor(options: ConversationDrivers['database']) {
    if (!options.conversations || !options.messages) {
      throw new Error("The database conversation driver needs both tables: { driver: 'database', conversations, messages }.")
    }
    this.dataMode = options.dataMode ?? 'json'
    this.conversations = class AiConversation extends Model {
      static override table = options.conversations
    }
    this.messages = class AiMessage extends Model {
      static override table = options.messages
    }
  }

  async create(meta: { agentName: string; owner: AgentPrincipal; messages: readonly ModelMessage[] }): Promise<string> {
    // Client-generated: MySQL returns no inserted key for a text primary key.
    const id = crypto.randomUUID()
    const stored = storableMessages(meta.messages)
    await this.messages.transaction(async () => {
      const now = new Date()
      await this.conversations.forceCreate({
        id,
        agentName: meta.agentName,
        owner: agentApprovalPrincipalKey(meta.owner),
        createdAt: now,
        updatedAt: now,
      })
      await this.insertMessages(id, 0, stored, now)
    })
    return id
  }

  async load(id: string, owner: AgentPrincipal): Promise<StoredConversation | null> {
    const conversation = await this.conversations.where({ id, owner: agentApprovalPrincipalKey(owner) }).first()
    if (!conversation) return null
    const rows = await this.messages.where({ conversationId: id }).orderBy('position').get()
    return {
      agentName: String(conversation.agentName),
      messages: rows.map((row) => (typeof row.message === 'string' ? JSON.parse(row.message) : row.message) as ModelMessage),
    }
  }

  async append(id: string, owner: AgentPrincipal, messages: readonly ModelMessage[]): Promise<void> {
    const ownerKey = agentApprovalPrincipalKey(owner)
    const stored = storableMessages(messages)
    // One transaction, so a replay never meets a tool call whose result was not written.
    // A concurrent append to the same conversation fails on the (conversationId, position) index.
    await this.messages.transaction(async () => {
      if (!(await this.conversations.where({ id, owner: ownerKey }).first())) throw unknownConversation(id)
      const last = await this.messages.where({ conversationId: id }).orderBy('position', 'desc').first()
      const now = new Date()
      await this.insertMessages(id, last ? Number(last.position) + 1 : 0, stored, now)
      await this.conversations.forceUpdate({ id }, { updatedAt: now })
    })
  }

  private async insertMessages(conversationId: string, from: number, messages: ModelMessage[], now: Date): Promise<void> {
    let position = from
    for (const message of messages) {
      await this.messages.forceCreate({
        id: crypto.randomUUID(),
        conversationId,
        position: position++,
        message: this.dataMode === 'text' ? JSON.stringify(message) : message,
        createdAt: now,
      })
    }
  }
}

function unknownConversation(id: string): Error {
  return new Error(`No conversation "${id}" belongs to this principal.`)
}

/**
 * A deep copy JSON can carry: binary file data becomes base64 and a `URL` its href,
 * both forms a `ModelMessage` accepts on replay.
 */
function storableMessages(messages: readonly ModelMessage[]): ModelMessage[] {
  return messages.map((message) => storable(message) as ModelMessage)
}

function storable(value: unknown): unknown {
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) return convertDataContentToBase64String(value)
  if (value instanceof URL) return value.href
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) return value.map(storable)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).filter(([, entry]) => entry !== undefined).map(([key, entry]) => [key, storable(entry)]),
    )
  }
  return value
}
