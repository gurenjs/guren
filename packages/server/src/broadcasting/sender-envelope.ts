/**
 * The sender of a broadcast, carried inside its payload (RFC 0037 §4) so every
 * driver passes it across instances. `__inertia.socketId` and `__inertia.userId`
 * are reserved: every manager publish path strips them from what the app passes
 * before marking, so a relayed payload cannot forge a mark, and delivery strips
 * them before any client sees the payload.
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

/** A user id that survives JSON as itself: `NaN` and the infinities become `null` on the Redis driver. */
export function isSenderUserId(value: unknown): value is string | number {
  return typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/**
 * The payload with the sender added. An object that is not plain (a class
 * instance, one with `toJSON()`) is marked as the JSON a client would receive;
 * an array or a primitive cannot carry a mark.
 */
export function markSender(data: unknown, sender: BroadcastSenderMark): unknown {
  const object = isPlainObject(data) ? data : asJsonObject(data)
  if (!object) return data
  const envelope = isPlainObject(object[ENVELOPE_KEY]) ? object[ENVELOPE_KEY] : {}
  return { ...object, [ENVELOPE_KEY]: { ...envelope, socketId: sender.socketId, userId: sender.userId } }
}

function asJsonObject(data: unknown): Record<string, unknown> | undefined {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return undefined
  const json: unknown = JSON.parse(JSON.stringify(data))
  return isPlainObject(json) ? json : undefined
}

export function readSender(data: unknown): BroadcastSenderMark | undefined {
  if (!isPlainObject(data) || !isPlainObject(data[ENVELOPE_KEY])) return undefined
  const { socketId, userId } = data[ENVELOPE_KEY]
  if (!isSocketId(socketId) || !isSenderUserId(userId)) return undefined
  return { socketId, userId }
}

/**
 * The payload without the reserved fields, valid or not, and without the
 * envelope once nothing else is in it.
 */
export function stripSender(data: unknown): unknown {
  if (!isPlainObject(data) || !isPlainObject(data[ENVELOPE_KEY])) return data
  if (!('socketId' in data[ENVELOPE_KEY]) && !('userId' in data[ENVELOPE_KEY])) return data
  const { socketId: _socketId, userId: _userId, ...rest } = data[ENVELOPE_KEY]
  const { [ENVELOPE_KEY]: _envelope, ...payload } = data
  return Object.keys(rest).length > 0 ? { ...payload, [ENVELOPE_KEY]: rest } : payload
}
