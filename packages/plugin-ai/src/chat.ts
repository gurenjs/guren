import { z } from 'zod'

/**
 * The body `createChatTransport()` posts: one user turn and the conversation it belongs to, never a
 * transcript. The store supplies history (RFC 0029 §4); `null` asks `stream()` to start a conversation.
 */
export const ChatTurnSchema = z.object({
  conversation: z.string().min(1).nullable(),
  message: z.string().min(1),
})

export type ChatTurn = z.infer<typeof ChatTurnSchema>
