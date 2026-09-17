/** The wire contract between `stream()` and `createChatTransport()`; imports nothing, so the client entry can share it. */
export const CONVERSATION_HEADER = 'X-Guren-Conversation'

/** The broadcast event `broadcast()` publishes each UI-message chunk as. */
export const AGENT_CHUNK_EVENT = 'AgentChunk'
