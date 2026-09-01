import { describe, test, expect } from 'bun:test'

import {
  AGENT_CIRCULAR,
  AGENT_REDACTED,
  AGENT_TRUNCATED,
  redactAgentArguments,
} from './redact'

describe('redactAgentArguments', () => {
  test('should leave arguments with no sensitive keys untouched', () => {
    expect(redactAgentArguments({ title: 'Hello', published: true, views: 3 })).toEqual({
      title: 'Hello',
      published: true,
      views: 3,
    })
  })

  test('should mask the default sensitive key names', () => {
    const redacted = redactAgentArguments({
      password: 'hunter2',
      passphrase: 'open sesame',
      secret: 's',
      token: 't',
      apiKey: 'k',
      api_key: 'k',
      authorization: 'Bearer x',
      credential: 'c',
      cookie: 'session=1',
      session: 'sid',
      privateKey: 'p',
      pwd: 'p',
      jwt: 'j',
      title: 'kept',
    })

    expect(redacted).toEqual({
      password: AGENT_REDACTED,
      passphrase: AGENT_REDACTED,
      secret: AGENT_REDACTED,
      token: AGENT_REDACTED,
      apiKey: AGENT_REDACTED,
      api_key: AGENT_REDACTED,
      authorization: AGENT_REDACTED,
      credential: AGENT_REDACTED,
      cookie: AGENT_REDACTED,
      session: AGENT_REDACTED,
      privateKey: AGENT_REDACTED,
      pwd: AGENT_REDACTED,
      jwt: AGENT_REDACTED,
      title: 'kept',
    })
  })

  test('should keep ordinary names that merely contain a short credential-ish substring', () => {
    // The reason `otp` is not a default fragment: over-masking is the safe
    // direction only while a fragment mostly hits credentials.
    expect(redactAgentArguments({ slotProvider: 'a', notPublic: false })).toEqual({
      slotProvider: 'a',
      notPublic: false,
    })
  })

  test('should match sensitive fragments case-insensitively and as substrings', () => {
    expect(
      redactAgentArguments({ ACCESS_TOKEN: 'a', refreshTokenValue: 'b', sessionCount: 4 })
    ).toEqual({ ACCESS_TOKEN: AGENT_REDACTED, refreshTokenValue: AGENT_REDACTED, sessionCount: AGENT_REDACTED })
  })

  test('should mask extra keys named by route metadata', () => {
    expect(redactAgentArguments({ ssn: '000', title: 'kept' }, ['ssn'])).toEqual({
      ssn: AGENT_REDACTED,
      title: 'kept',
    })
  })

  test('should apply the substring rule to route metadata too', () => {
    expect(redactAgentArguments({ userId: 7, id: 1, title: 'kept' }, ['id'])).toEqual({
      userId: AGENT_REDACTED,
      id: AGENT_REDACTED,
      title: 'kept',
    })
  })

  test('should ignore an empty redact entry rather than masking everything', () => {
    expect(redactAgentArguments({ title: 'kept' }, [''])).toEqual({ title: 'kept' })
  })

  test('should mask by key regardless of the value shape', () => {
    const redacted = redactAgentArguments({
      token: { value: 'v', nested: { deep: 1 } },
      credentials: ['a', 'b'],
      createdAt: new Date('2024-01-15T10:30:00Z'),
    })

    expect(redacted.token).toBe(AGENT_REDACTED)
    expect(redacted.credentials).toBe(AGENT_REDACTED)
    expect(redacted.createdAt).toBeInstanceOf(Date)
  })

  test('should walk nested objects and arrays', () => {
    expect(
      redactAgentArguments({
        user: { name: 'Ada', password: 'p' },
        items: [{ token: 't', label: 'one' }, { label: 'two' }],
      })
    ).toEqual({
      user: { name: 'Ada', password: AGENT_REDACTED },
      items: [{ token: AGENT_REDACTED, label: 'one' }, { label: 'two' }],
    })
  })

  test('should not mutate the input', () => {
    const args = { user: { password: 'p' } }

    redactAgentArguments(args)

    expect(args.user.password).toBe('p')
  })

  test('should deep copy the structures it walks', () => {
    const args = { user: { name: 'Ada' }, tags: ['a'] }
    const redacted = redactAgentArguments(args) as typeof args

    expect(redacted.user).not.toBe(args.user)
    expect(redacted.tags).not.toBe(args.tags)
    expect(redacted).toEqual(args)
  })

  test('should carry non-plain objects across by reference', () => {
    const createdAt = new Date('2024-01-15T10:30:00Z')
    const tags = new Set(['a'])

    const redacted = redactAgentArguments({ createdAt, tags })

    expect(redacted.createdAt).toBe(createdAt)
    expect(redacted.tags).toBe(tags)
  })

  test('should copy a shared reference twice rather than calling it circular', () => {
    const shared = { password: 'p', label: 'shared' }
    const redacted = redactAgentArguments({ first: shared, second: shared })

    expect(redacted.first).toEqual({ password: AGENT_REDACTED, label: 'shared' })
    expect(redacted.second).toEqual({ password: AGENT_REDACTED, label: 'shared' })
    expect(redacted.first).not.toBe(redacted.second)
  })

  test('should terminate on a self-referencing object', () => {
    const args: Record<string, unknown> = { label: 'root', token: 't' }
    args.self = args

    const redacted = redactAgentArguments(args)

    expect(redacted).toEqual({ label: 'root', token: AGENT_REDACTED, self: AGENT_CIRCULAR })
  })

  test('should terminate on a cycle through an array', () => {
    const inner: Record<string, unknown> = { label: 'inner' }
    const list: unknown[] = [inner]
    inner.list = list

    const redacted = redactAgentArguments({ list }) as { list: Array<{ list: unknown }> }

    expect(redacted.list[0]!.list).toBe(AGENT_CIRCULAR)
  })

  test('should truncate instead of overflowing on a deeply nested payload', () => {
    let deep: Record<string, unknown> = { token: 'leaf' }
    for (let level = 0; level < 5_000; level += 1) {
      deep = { next: deep }
    }

    const redacted = redactAgentArguments(deep)

    expect(JSON.stringify(redacted)).toContain(AGENT_TRUNCATED)
  })

  test('should keep a payload just inside the depth limit whole', () => {
    let deep: Record<string, unknown> = { token: 'leaf' }
    for (let level = 0; level < 60; level += 1) {
      deep = { next: deep }
    }

    const serialized = JSON.stringify(redactAgentArguments(deep))

    expect(serialized).toContain(AGENT_REDACTED)
    expect(serialized).not.toContain(AGENT_TRUNCATED)
  })

  test('should truncate a deeply nested array without throwing', () => {
    let deep: unknown = ['leaf']
    for (let level = 0; level < 5_000; level += 1) {
      deep = [deep]
    }

    expect(JSON.stringify(redactAgentArguments({ deep }))).toContain(AGENT_TRUNCATED)
  })

  test('should not pollute the prototype through a __proto__ argument', () => {
    const args = JSON.parse('{"__proto__": {"polluted": true}, "title": "kept"}') as Record<
      string,
      unknown
    >

    const redacted = redactAgentArguments(args)

    expect(Object.prototype.hasOwnProperty.call(redacted, '__proto__')).toBe(true)
    expect((redacted as Record<string, unknown>).title).toBe('kept')
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect((redacted as { polluted?: unknown }).polluted).toBeUndefined()
  })

  test('should keep a nested __proto__ key as an own property too', () => {
    const args = JSON.parse('{"user": {"__proto__": {"polluted": true}}}') as Record<
      string,
      unknown
    >

    const redacted = redactAgentArguments(args) as { user: Record<string, unknown> }

    expect(Object.prototype.hasOwnProperty.call(redacted.user, '__proto__')).toBe(true)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  test('should return a plain object a consumer can call hasOwnProperty on', () => {
    const redacted = redactAgentArguments({ title: 'kept' })

    expect(Object.getPrototypeOf(redacted)).toBe(Object.prototype)
    expect(Object.prototype.hasOwnProperty.call(redacted, 'title')).toBe(true)
  })

  test('should walk a null-prototype argument record', () => {
    const args = Object.create(null) as Record<string, unknown>
    args.token = 't'
    args.title = 'kept'

    expect(redactAgentArguments(args)).toEqual({ token: AGENT_REDACTED, title: 'kept' })
  })

  test('should handle an empty record', () => {
    expect(redactAgentArguments({})).toEqual({})
  })

  test('should preserve null and undefined values', () => {
    expect(redactAgentArguments({ a: null, b: undefined })).toEqual({ a: null, b: undefined })
  })
})

describe('redactAgentArguments totality on non-object roots', () => {
  // A denial is recorded before any validation, so the type annotation does
  // not protect this path — a raw JSON-RPC call can put anything here.
  const asArgs = (value: unknown) => value as Record<string, unknown>

  test('should return an empty record for a null root', () => {
    expect(redactAgentArguments(asArgs(null))).toEqual({})
  })

  test('should return an empty record for an undefined root', () => {
    expect(redactAgentArguments(asArgs(undefined))).toEqual({})
  })

  test('should return an empty record for a scalar root', () => {
    expect(redactAgentArguments(asArgs('a string'))).toEqual({})
    expect(redactAgentArguments(asArgs(42))).toEqual({})
    expect(redactAgentArguments(asArgs(true))).toEqual({})
  })
})

describe('redactAgentArguments separator normalization', () => {
  test('should mask hyphenated spellings of built-in fragments', () => {
    expect(
      redactAgentArguments({
        'X-Api-Key': 'sk-live',
        'api-key': 'sk-2',
        'x-auth-token': 't',
        'Set-Cookie': 'sid=1',
      }),
    ).toEqual({
      'X-Api-Key': AGENT_REDACTED,
      'api-key': AGENT_REDACTED,
      'x-auth-token': AGENT_REDACTED,
      'Set-Cookie': AGENT_REDACTED,
    })
  })

  test('should normalize declared redact entries the same way', () => {
    expect(redactAgentArguments({ ssnNumber: '123', taxId: 'x' }, ['ssn-number', 'TAX_ID'])).toEqual({
      ssnNumber: AGENT_REDACTED,
      taxId: AGENT_REDACTED,
    })
  })

  test('should skip a redact entry that normalizes to nothing', () => {
    expect(redactAgentArguments({ title: 'Hello' }, ['-', '_ '])).toEqual({ title: 'Hello' })
  })
})

describe('redactAgentArguments on an array root', () => {
  test('should walk it as an index-keyed record, still masking', () => {
    // Not a legal MCP arguments shape, but reachable pre-validation; total
    // and masked is the contract, and this pins the shape it comes back in.
    expect(redactAgentArguments(['a', { token: 't' }] as unknown as Record<string, unknown>)).toEqual({
      '0': 'a',
      '1': { token: AGENT_REDACTED },
    })
  })
})
