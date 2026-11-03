/**
 * The sender of a broadcast, carried inside its payload (RFC 0037 §4) so every
 * driver passes it across instances untouched. Under Inertia's `__inertia` key
 * because its client drops an event whose `__inertia.socketId` is its own. The
 * manager removes both fields before any client sees the payload.
 */

const ENVELOPE_KEY = '__inertia'

/** `s_` and 32 hex digits: what `registerWebSocketClient()` issues. */
const SOCKET_ID_PATTERN = /^s_[0-9a-f]{32}$/

export interface BroadcastSenderMark {
  readonly socketId: string
  readonly userId: string | number
}

export function isSocketId(value: unknown): value is string {
  return typeof value === 'string' && SOCKET_ID_PATTERN.test(value)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/** The payload with the sender added; a payload that is not a plain object cannot carry one. */
export function markSender(data: unknown, sender: BroadcastSenderMark): unknown {
  if (!isPlainObject(data)) return data
  const envelope = isPlainObject(data[ENVELOPE_KEY]) ? data[ENVELOPE_KEY] : {}
  return { ...data, [ENVELOPE_KEY]: { ...envelope, socketId: sender.socketId, userId: sender.userId } }
}

export function readSender(data: unknown): BroadcastSenderMark | undefined {
  if (!isPlainObject(data) || !isPlainObject(data[ENVELOPE_KEY])) return undefined
  const { socketId, userId } = data[ENVELOPE_KEY]
  if (!isSocketId(socketId) || (typeof userId !== 'string' && typeof userId !== 'number')) return undefined
  return { socketId, userId }
}

/** The payload without the sender, and without the envelope once nothing else is in it. */
export function stripSender(data: unknown): unknown {
  if (!isPlainObject(data) || !isPlainObject(data[ENVELOPE_KEY])) return data
  const { socketId: _socketId, userId: _userId, ...rest } = data[ENVELOPE_KEY]
  const { [ENVELOPE_KEY]: _envelope, ...payload } = data
  return Object.keys(rest).length > 0 ? { ...payload, [ENVELOPE_KEY]: rest } : payload
}
