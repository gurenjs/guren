/**
 * Argument masking for the agent audit trail (RFC 0016 §5.2). Two sources,
 * unioned: a fixed list of sensitive key *fragments* every application gets,
 * and the route's own `.agent({ redact })`.
 *
 * A key matches when its lowercased name *contains* a fragment, declared
 * entries included — `redact: ['id']` also masks `userId`. Over-redaction is
 * the safe direction: a needless mask costs a debugging round trip, an unmasked
 * credential costs a rotation. The walk is total because it runs while
 * recording what happened, including a denial taken before validation: a cycle
 * and a payload nested past {@link MAX_DEPTH} both terminate with a marker.
 */

/**
 * The replacement written in place of a masked value. A string, so a redacted
 * record still serializes as JSON and reads the same in every sink.
 */
export const AGENT_REDACTED = '[REDACTED]'

/**
 * Written in place of a value that closes a cycle. Distinct from
 * {@link AGENT_REDACTED} on purpose: one says "we would not show you", the
 * other "there is nothing further here to show".
 */
export const AGENT_CIRCULAR = '[Circular]'

/**
 * Written in place of a value nested deeper than {@link MAX_DEPTH}.
 */
export const AGENT_TRUNCATED = '[Truncated]'

/**
 * How deep the walk goes before it stops descending. A deeply nested argument
 * record ends recursion with a `RangeError`, and this is the audit path: a
 * denial is recorded before the route's own validation, so an overflow here
 * would suppress the very `AgentToolDenied` saying a hostile call arrived. Far
 * past anything a tool input schema describes.
 */
const MAX_DEPTH = 64

/**
 * Key-name fragments masked in every application. Spelled in the normalized
 * form {@link normalizeKeyText} produces — lowercase, no separators — so
 * `Authorization`, `apiKey`, `API_KEY` and `x-api-key` are all covered by
 * their one entry.
 */
const DEFAULT_SENSITIVE_KEY_FRAGMENTS: readonly string[] = [
  'password',
  'passphrase',
  'secret',
  'token',
  'apikey',
  'authorization',
  'credential',
  'cookie',
  'session',
  // Spellings the list above does not reach: `privateKey` shares no fragment
  // with `secret`, `jwt` and `pwd` share none with `token` or `password`.
  // Deliberately absent: a bare `otp`, a substring of ordinary names
  // (`slotProvider`, `notPublic`) — over-masking is the safe direction for a
  // *credential* fragment, not for one that mostly hits non-credentials.
  'privatekey',
  'pwd',
  'jwt',
]

/**
 * The form keys and fragments are compared in: lowercased, separators removed,
 * so `apiKey`, `api_key` and `X-Api-Key` are one name. A literal substring test
 * would let the hyphenated spelling through, and header-shaped argument names
 * are exactly where credentials live. Applied to declared `redact` entries too.
 */
function normalizeKeyText(text: string): string {
  return text.toLowerCase().replace(/[-_\s]/gu, '')
}

/**
 * Mask the sensitive fields of an agent tool's arguments.
 *
 * Returns a deep copy — but deep only through plain objects and arrays.
 * Anything else (a `Date`, a `Map`, a class instance) is carried across by the
 * same reference and never inspected, so a credential inside one is masked only
 * if the key holding it matches. Tool arguments arrive as parsed JSON on every
 * surface; only an in-process caller can hit that case.
 *
 * @param args The invocation arguments. Walked as a record whatever its
 *   prototype, so the return is always a fresh plain object.
 * @param redact Extra key fragments from the route's `.agent({ redact })`.
 */
export function redactAgentArguments(
  args: Record<string, unknown>,
  redact?: readonly string[]
): Record<string, unknown> {
  // Total on the audit path, and the type annotation is no guard there: a
  // denial is recorded before any validation, so `arguments: null` from a raw
  // JSON-RPC call arrives here as-is. An empty record is the whole truth.
  if (args === null || typeof args !== 'object') return {}

  const fragments = [...DEFAULT_SENSITIVE_KEY_FRAGMENTS]
  for (const entry of redact ?? []) {
    const fragment = normalizeKeyText(entry)
    // An empty fragment is a substring of every key and would mask the whole
    // record — a typo in route metadata rather than a request to log nothing.
    if (fragment.length > 0) fragments.push(fragment)
  }

  // The root is on the ancestor path like any other node, so an argument
  // referencing the whole record is `[Circular]` at its own depth.
  const ancestors = new WeakSet<object>([args])
  return redactRecord(args, fragments, ancestors, 0)
}

/** Whether a key name should have its value masked. */
function isSensitiveKey(key: string, fragments: readonly string[]): boolean {
  const normalized = normalizeKeyText(key)
  return fragments.some((fragment) => normalized.includes(fragment))
}

/**
 * Copy one object's entries, masking sensitive keys.
 *
 * Accumulates on a null-prototype object: an argument named `__proto__`
 * survives `JSON.parse` as an own property, and assigning it on a plain `{}`
 * invokes the prototype setter — the value would vanish and a crafted payload
 * would reach the prototype chain from inside the logging path. Spread back
 * onto a normal object *defines* own properties; `Object.assign` would assign
 * them, putting the hazard straight back.
 */
function redactRecord(
  source: object,
  fragments: readonly string[],
  ancestors: WeakSet<object>,
  depth: number
): Record<string, unknown> {
  const accumulator = Object.create(null) as Record<string, unknown>
  for (const [key, value] of Object.entries(source)) {
    // The key decides before the value's shape does: a `Date` or a nested
    // object under a key named `token` is masked whole, not walked.
    accumulator[key] = isSensitiveKey(key, fragments)
      ? AGENT_REDACTED
      : redactValue(value, fragments, ancestors, depth + 1)
  }
  return { ...accumulator }
}

/** Copy one value, masking the sensitive keys anywhere beneath it. */
function redactValue(
  value: unknown,
  fragments: readonly string[],
  ancestors: WeakSet<object>,
  depth: number
): unknown {
  if (value === null || typeof value !== 'object') return value
  if (!isWalkable(value)) return value
  // Checked before the walk, not inside it: the point is to never make the
  // call that would overflow. See MAX_DEPTH.
  if (depth > MAX_DEPTH) return AGENT_TRUNCATED

  // Ancestors, not "everything seen": a visited-set would report the second
  // reference to a shared object as a cycle, and a record referencing one object
  // from two keys is a DAG. Removing on the way out keeps the set to the path.
  if (ancestors.has(value)) return AGENT_CIRCULAR
  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      return value.map((element) => redactValue(element, fragments, ancestors, depth + 1))
    }
    return redactRecord(value, fragments, ancestors, depth)
  } finally {
    ancestors.delete(value)
  }
}

/**
 * Whether a value is a structure this walks: an array, or an object with no
 * prototype or the plain one. Everything else is carried across by reference
 * (see {@link redactAgentArguments}).
 */
function isWalkable(value: object): boolean {
  if (Array.isArray(value)) return true
  const prototype = Object.getPrototypeOf(value) as unknown
  return prototype === null || prototype === Object.prototype
}
