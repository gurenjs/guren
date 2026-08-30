/**
 * Argument masking for the agent audit trail (RFC 0016 §5.2).
 *
 * Agent tool arguments are logged by default, which is only safe if the
 * logging path masks the fields that must not be written down. Two sources,
 * unioned: a fixed list of sensitive key *fragments* every application gets
 * without asking, and the route's own `.agent({ redact })` metadata.
 *
 * The rule is deliberately blunt — a key matches when its lowercased name
 * *contains* a fragment, and that applies to the declared `redact` entries
 * too, not just the built-ins. So `redact: ['id']` also masks `userId`, and
 * the built-in `session` masks `sessionCount`. Over-redaction is the safe
 * direction for a log: a masked field that did not need masking costs a
 * debugging round trip, an unmasked credential costs a rotation.
 *
 * The walk is total for the same reason the derivation is: it runs while
 * *recording* what happened, including a denial taken before the route's own
 * validation, so it must not be the thing that throws. A cycle and a payload
 * nested past {@link MAX_DEPTH} both terminate with a marker.
 */

/**
 * The replacement written in place of a masked value. A string, so a redacted
 * record still serializes as JSON and reads the same in every sink.
 */
export const AGENT_REDACTED = '[REDACTED]'

/**
 * Written in place of a value that closes a cycle, so a self-referencing
 * argument object produces a finite record instead of throwing or hanging.
 * Distinct from {@link AGENT_REDACTED} on purpose: one says "we would not show
 * you", the other "there is nothing further here to show".
 */
export const AGENT_CIRCULAR = '[Circular]'

/**
 * Written in place of a value nested deeper than {@link MAX_DEPTH}.
 */
export const AGENT_TRUNCATED = '[Truncated]'

/**
 * How deep the walk goes before it stops descending.
 *
 * A cycle is not the only way an argument record ends recursion badly: a
 * deeply nested one ends it with a `RangeError`. That matters here more than
 * in an ordinary utility, because this is the *audit* path and a denial is
 * recorded before the route's own schema validation has run — an argument
 * payload that overflows the stack would throw inside the code writing the
 * record about it, suppressing the very `AgentToolDenied` that says a
 * hostile call arrived. Truncating keeps the record.
 *
 * Far past anything a tool input schema describes; a record this deep is
 * already unreadable in a log.
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
]

/**
 * The form keys and fragments are compared in: lowercased, with separator
 * characters removed. `apiKey`, `api_key`, `api-key` and `X-Api-Key` are the
 * same name to a human reading a log, so they must be the same name to the
 * mask — a literal substring test lets the hyphenated spelling of a fragment
 * through, and header-shaped argument names (`x-api-key`) are exactly where
 * credentials live. Applied to declared `redact` entries too, so a route
 * author writes any spelling.
 */
function normalizeKeyText(text: string): string {
  return text.toLowerCase().replace(/[-_\s]/gu, '')
}

/**
 * Mask the sensitive fields of an agent tool's arguments.
 *
 * Returns a deep copy: the input is never mutated, and a caller may keep
 * holding the unredacted original. The copy is deep only through the
 * structures this walks — plain objects and arrays. Anything else (a `Date`,
 * a `Map`, a `Set`, a class instance) is carried across as the *same
 * reference*, because copying it would need a rule per type and would still
 * get the exotic cases wrong; nothing below such a value is inspected, so a
 * credential hidden inside a class instance is masked only if the key holding
 * that instance matches. Tool arguments arrive as parsed JSON on every
 * surface, where this case does not occur; a caller synthesizing arguments in
 * process is the one that can hit it.
 *
 * @param args The invocation arguments. Walked as a record whatever its
 *   prototype, so the return is always a fresh plain object.
 * @param redact Extra key fragments from the route's `.agent({ redact })`.
 */
export function redactAgentArguments(
  args: Record<string, unknown>,
  redact?: readonly string[]
): Record<string, unknown> {
  // The whole point of this function is to be total on the audit path, and
  // the type annotation is no guard there: a denial is recorded before any
  // validation, so `arguments: null` from a raw JSON-RPC call arrives here
  // as-is. A root that is not an object has no keys to mask and nothing to
  // walk — an empty record is the whole truth about it.
  if (args === null || typeof args !== 'object') return {}

  const fragments = [...DEFAULT_SENSITIVE_KEY_FRAGMENTS]
  for (const entry of redact ?? []) {
    const fragment = normalizeKeyText(entry)
    // An empty fragment is a substring of every key and would mask the whole
    // record — almost certainly a typo in route metadata rather than a
    // request to log nothing.
    if (fragment.length > 0) fragments.push(fragment)
  }

  // The root is on the ancestor path like any other node, so an argument
  // referencing the whole record is `[Circular]` at its own depth rather than
  // one copy deeper.
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
 * survives `JSON.parse` as an own property, and assigning that key on a
 * plain `{}` invokes the prototype setter instead of defining a property —
 * the value would vanish from the record, and a crafted payload would be
 * reaching the prototype chain from inside the logging path. The result is
 * then spread onto a normal object so a consumer calling `hasOwnProperty` on
 * it works; spread *defines* own properties (`Object.assign` would assign
 * them, putting the `__proto__` hazard straight back).
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

  // Ancestors, not "everything seen": a plain visited-set would report the
  // second reference to a shared object as a cycle, and an argument record
  // referencing one object from two keys is a DAG, not a loop. Removing the
  // node on the way out keeps the set to the current path.
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
