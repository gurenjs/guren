/**
 * Strips SQL bound parameters out of an exception before anything prints it:
 * drizzle's `DrizzleQueryError` writes `Failed query: <sql>\nparams: <values>`
 * into its message and stack and keeps the values on `.params`, so a failed
 * INSERT would hand a password hash to the 500 body, the debug page and the log.
 * The shape is detected structurally, since the app may load its own drizzle.
 */

const QUERY_PREFIX = 'Failed query: '
const PARAMS_SEPARATOR = '\nparams: '
const REDACTED_PREFIX = '[redacted'
// `params` is drizzle's; `parameters` and `args` are what postgres.js attaches
// to a driver error (enumerable only under its `debug` option).
const PARAM_KEYS = ['params', 'parameters', 'args'] as const
// Past this many causes the rest of the chain is dropped rather than printed unread.
const MAX_CAUSE_DEPTH = 32

function marker(count?: number): string {
  if (count === undefined) return `${REDACTED_PREFIX}]`
  return `${REDACTED_PREFIX} ${count} value${count === 1 ? '' : 's'}]`
}

/**
 * The text with the values after `\nparams: ` of a drizzle query failure
 * replaced, else as given. A message is redacted to its end; a stack (`stack`)
 * up to its first frame.
 */
function redactQueryParamsText(text: string, query?: string, count?: number, stack = false): string {
  const known = query === undefined ? -1 : text.indexOf(`${QUERY_PREFIX}${query}${PARAMS_SEPARATOR}`)
  let valuesStart: number
  if (known !== -1) {
    valuesStart = known + QUERY_PREFIX.length + query!.length + PARAMS_SEPARATOR.length
  } else {
    const start = text.indexOf(QUERY_PREFIX)
    const separator = start === -1 ? -1 : text.indexOf(PARAMS_SEPARATOR, start)
    if (separator === -1) return text
    valuesStart = separator + PARAMS_SEPARATOR.length
    count = undefined
  }
  if (text.startsWith(REDACTED_PREFIX, valuesStart)) return text
  const frames = stack ? text.indexOf('\n    at ', valuesStart) : -1
  const valuesEnd = frames === -1 ? text.length : frames
  return text.slice(0, valuesStart) + marker(count) + text.slice(valuesEnd)
}

/** mysql2 formats the values into the statement client-side and keeps the result on `err.sql`. */
function isMysqlDriverError(error: object): boolean {
  return typeof (error as { sql?: unknown }).sql === 'string' && ('sqlState' in error || 'sqlMessage' in error)
}

function queryOf(error: object): string | undefined {
  const query = (error as { query?: unknown }).query
  return typeof query === 'string' ? query : undefined
}

function paramCount(error: object): number | undefined {
  const params = (error as { params?: unknown }).params
  return Array.isArray(params) ? params.length : undefined
}

function needsRedaction(error: Error, seen: Set<unknown>): boolean {
  if (seen.has(error)) return false
  if (seen.size >= MAX_CAUSE_DEPTH) return true
  seen.add(error)
  const query = queryOf(error)
  if (query !== undefined && PARAM_KEYS.some((key) => Array.isArray((error as unknown as Record<string, unknown>)[key]))) {
    return true
  }
  if (isMysqlDriverError(error)) return true
  if (redactQueryParamsText(error.message ?? '') !== error.message) return true
  if (typeof error.stack === 'string' && redactQueryParamsText(error.stack, undefined, undefined, true) !== error.stack) return true
  const cause = (error as { cause?: unknown }).cause
  return cause instanceof Error && needsRedaction(cause, seen)
}

function redactStack(stack: string, message: string, redacted: string, query?: string, count?: number): string {
  const at = message === redacted ? -1 : stack.indexOf(message)
  if (at !== -1) return stack.slice(0, at) + redacted + stack.slice(at + message.length)
  return redactQueryParamsText(stack, query, count, true)
}

function redactCopy(error: Error, seen: Map<Error, Error>): Error {
  const existing = seen.get(error)
  if (existing) return existing
  const query = queryOf(error)
  const count = paramCount(error)
  const message = redactQueryParamsText(error.message ?? '', query, count)
  const copy = new Error(message)
  Object.setPrototypeOf(copy, Object.getPrototypeOf(error))
  seen.set(error, copy)

  const mysql = isMysqlDriverError(error)
  for (const key of Object.keys(error)) {
    if (key === 'message' || key === 'stack' || key === 'cause') continue
    const value = (error as unknown as Record<string, unknown>)[key]
    const isParams = query !== undefined && (PARAM_KEYS as readonly string[]).includes(key) && Array.isArray(value)
    Object.defineProperty(copy, key, {
      value: isParams ? marker((value as unknown[]).length) : mysql && key === 'sql' ? marker() : value,
      enumerable: true, writable: true, configurable: true,
    })
  }

  const stack = typeof error.stack === 'string'
    ? redactStack(error.stack, error.message ?? '', message, query, count)
    : error.stack
  Object.defineProperty(copy, 'stack', { value: stack, enumerable: false, writable: true, configurable: true })

  if ('cause' in error) {
    const cause = (error as { cause?: unknown }).cause
    const descriptor = Object.getOwnPropertyDescriptor(error, 'cause')
    Object.defineProperty(copy, 'cause', {
      value: !(cause instanceof Error) ? cause : seen.size < MAX_CAUSE_DEPTH ? redactCopy(cause, seen) : undefined,
      enumerable: descriptor?.enumerable ?? false, writable: true, configurable: true,
    })
  }
  return copy
}

/**
 * The error itself when nothing in it or its cause chain carries bound
 * parameters; otherwise a copy with the same prototype (so `instanceof` and
 * `name` hold) whose message, stack, `params` and causes are redacted.
 */
export function redactQueryParams<T extends Error>(error: T): T {
  if (!needsRedaction(error, new Set())) return error
  return redactCopy(error, new Map()) as T
}

/** `error.message` with bound parameters redacted, for a log line that prints the message alone. */
export function redactedMessage(error: unknown): string | undefined {
  if (error instanceof Error) return redactQueryParams(error).message
  const message = (error as { message?: unknown } | null | undefined)?.message
  return typeof message === 'string' ? redactQueryParamsText(message) : undefined
}
