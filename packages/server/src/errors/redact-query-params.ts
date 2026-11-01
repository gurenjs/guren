/**
 * Strips SQL bound parameters out of an exception before anything prints it:
 * drizzle's `DrizzleQueryError` writes `Failed query: <sql>\nparams: <values>`
 * into its message and stack and keeps the values on `.params`, so a failed
 * INSERT would hand a password hash to the 500 body, the debug page and the log.
 * The shape is detected structurally, since the app may load its own drizzle.
 */

const QUERY_PREFIX = 'Failed query: '
const PARAMS_SEPARATOR = '\nparams: '
const REDACTED = '[redacted'
// `params` is drizzle's; `parameters` and `args` are what postgres.js attaches
// to a driver error (enumerable only under its `debug` option).
const PARAM_KEYS = new Set<PropertyKey>(['params', 'parameters', 'args'])

type Fields = Record<PropertyKey, unknown>

function marker(count?: number): string {
  return count === undefined ? `${REDACTED}]` : `${REDACTED} ${count} value${count === 1 ? '' : 's'}]`
}

/** drizzle's own shape, which says where the values start and how many there are. */
function drizzleShape(error: Error): { query: string; count: number } | undefined {
  const { query, params } = error as unknown as Fields
  return typeof query === 'string' && Array.isArray(params) ? { query, count: params.length } : undefined
}

/** mysql2 formats the values into the statement client-side and keeps it on `err.sql`. */
function isMysqlDriverError(error: Error): boolean {
  return typeof (error as unknown as Fields).sql === 'string' && ('sqlState' in error || 'sqlMessage' in error)
}

function isSensitive(error: Error, key: PropertyKey, value: unknown): boolean {
  if (key === 'sql') return isMysqlDriverError(error)
  return PARAM_KEYS.has(key) && Array.isArray(value) && typeof (error as unknown as Fields).query === 'string'
}

/** A message is cut to its end; a stack only up to its first frame. */
function redactText(text: string, shape?: { query: string; count: number }, stack = false): string {
  const prefix = shape ? `${QUERY_PREFIX}${shape.query}${PARAMS_SEPARATOR}` : undefined
  const known = prefix ? text.indexOf(prefix) : -1
  let start: number
  if (known !== -1) {
    start = known + prefix!.length
  } else {
    const query = text.indexOf(QUERY_PREFIX)
    const separator = query === -1 ? -1 : text.indexOf(PARAMS_SEPARATOR, query)
    if (separator === -1) return text
    start = separator + PARAMS_SEPARATOR.length
  }
  if (text.startsWith(REDACTED, start)) return text
  const frames = stack ? text.indexOf('\n    at ', start) : -1
  return text.slice(0, start) + marker(known !== -1 ? shape!.count : undefined) + text.slice(frames === -1 ? text.length : frames)
}

function redactStack(error: Error, message: string): string | undefined {
  const { stack } = error
  if (typeof stack !== 'string') return stack
  const at = message === error.message ? -1 : stack.indexOf(error.message)
  if (at !== -1) return stack.slice(0, at) + message + stack.slice(at + error.message.length)
  return redactText(stack, drizzleShape(error), true)
}

function needsRedaction(error: Error, seen: Set<Error>): boolean {
  if (seen.has(error)) return false
  seen.add(error)
  const sensitive = Reflect.ownKeys(error).some((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(error, key)!
    return 'value' in descriptor && isSensitive(error, key, descriptor.value)
  })
  if (sensitive) return true
  if (redactText(error.message) !== error.message) return true
  if (typeof error.stack === 'string' && redactText(error.stack, undefined, true) !== error.stack) return true
  const { cause } = error
  return cause instanceof Error && needsRedaction(cause, seen)
}

function redactCopy(error: Error, seen: Map<Error, Error>): Error {
  const existing = seen.get(error)
  if (existing) return existing
  const copy = new Error()
  Object.setPrototypeOf(copy, Object.getPrototypeOf(error))
  seen.set(error, copy)

  const message = redactText(error.message, drizzleShape(error))
  for (const key of Reflect.ownKeys(error)) {
    const descriptor = Object.getOwnPropertyDescriptor(error, key)!
    if ('value' in descriptor) {
      const { value } = descriptor
      if (key === 'message') descriptor.value = message
      else if (key === 'stack') descriptor.value = redactStack(error, message)
      else if (key === 'cause' && value instanceof Error) descriptor.value = redactCopy(value, seen)
      else if (isSensitive(error, key, value)) descriptor.value = marker(Array.isArray(value) ? value.length : undefined)
    }
    Object.defineProperty(copy, key, descriptor)
  }
  return copy
}

/**
 * The value itself unless it is an error that, or whose cause chain, carries
 * bound parameters; then a copy with the same prototype and own properties
 * whose message, stack, parameter fields and causes are redacted. Being a copy,
 * it carries no `#private` field a custom renderer or `toResponse()` reads.
 */
export function redactQueryParams<T>(error: T): T {
  if (!(error instanceof Error) || !needsRedaction(error, new Set())) return error
  return redactCopy(error, new Map()) as T
}

/** `error.message` with bound parameters redacted, for a log line that prints the message alone. */
export function redactedMessage(error: unknown): string | undefined {
  return error instanceof Error ? redactQueryParams(error).message : undefined
}
