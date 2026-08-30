import { describe, it, expect } from 'bun:test'
import { MemoryApiTokenStore, type ScopedTool } from '@guren/core'
import {
  issueAgentToken,
  normalizeToolScope,
  parseExpiresDuration,
  parseUserId,
  planTokenIssue,
} from '../src/token-issue'

/**
 * The tool list every case below is judged against. Injected rather than
 * derived from a routes file on disk: these tests are about the issuance
 * rules, and `tool-list.test.ts` already covers the derivation that feeds
 * them.
 */
const TOOLS: ScopedTool[] = [
  { name: 'posts.index', readOnly: true },
  { name: 'posts.show', readOnly: true },
  { name: 'posts.store', readOnly: false },
  { name: 'comments.destroy', readOnly: false },
]

describe('normalizeToolScope', () => {
  it('expands each shorthand to its full scope form', () => {
    expect(normalizeToolScope('*')).toBe('tools:*')
    expect(normalizeToolScope('read')).toBe('tools:read')
    expect(normalizeToolScope('posts.*')).toBe('tools:posts.*')
    expect(normalizeToolScope('posts.store')).toBe('tool:posts.store')
  })

  it('passes full scope syntax through verbatim', () => {
    for (const scope of ['tool:posts.store', 'tools:read', 'tools:*', 'tools:posts.*']) {
      expect(normalizeToolScope(scope)).toBe(scope)
    }
  })

  it('does not rewrite a malformed full scope into a legal one', () => {
    // `tool:posts.*` is not a prefix scope, and guessing that it meant one
    // would be the issuer inventing intent. It stays as written so the
    // parse gate can reject it by name.
    expect(normalizeToolScope('tool:posts.*')).toBe('tool:posts.*')
  })
})

describe('parseExpiresDuration', () => {
  it('reads days, hours and minutes', () => {
    expect(parseExpiresDuration('30d')).toBe(30 * 24 * 60 * 60_000)
    expect(parseExpiresDuration('12h')).toBe(12 * 60 * 60_000)
    expect(parseExpiresDuration('45m')).toBe(45 * 60_000)
  })

  it('rejects anything outside the three-unit grammar', () => {
    for (const value of ['30', '30s', '30 d', 'd30', '1.5d', '-5d', '']) {
      expect(() => parseExpiresDuration(value)).toThrow('Invalid --expires value')
    }
  })

  it('rejects zero rather than minting an already-expired token', () => {
    expect(() => parseExpiresDuration('0d')).toThrow('Invalid --expires value')
  })

  it('rejects a duration that would overflow the Date range', () => {
    // `now + expiresIn` past the Date range is an Invalid Date, which every
    // expiry check reads as expired — a dead token reported as issued.
    expect(() => parseExpiresDuration('99999999999999d')).toThrow('Invalid --expires value')
    // The bound is generous; a century still parses.
    expect(parseExpiresDuration('36500d')).toBe(36_500 * 24 * 60 * 60_000)
  })
})

describe('parseUserId', () => {
  it('reads a digits-only value as the number a serial key is', () => {
    expect(parseUserId('42')).toBe(42)
  })

  it('leaves a non-numeric identifier a string', () => {
    expect(parseUserId('01HZY0S6')).toBe('01HZY0S6')
  })
})

describe('planTokenIssue', () => {
  it('stores patterns verbatim and reports the tools they expand to', () => {
    const plan = planTokenIssue({ tools: 'posts.*', expires: '30d' }, TOOLS)

    expect(plan.abilities).toEqual(['tools:posts.*'])
    expect(plan.granted.readOnly).toEqual(['posts.index', 'posts.show'])
    expect(plan.granted.write).toEqual(['posts.store'])
    expect(plan.expiresIn).toBe(30 * 24 * 60 * 60_000)
  })

  it('accepts several entries and drops exact repeats', () => {
    const plan = planTokenIssue({ tools: 'read, posts.store , read', expires: '1d' }, TOOLS)

    expect(plan.abilities).toEqual(['tools:read', 'tool:posts.store'])
  })

  it('requires at least one scope', () => {
    expect(() => planTokenIssue({ tools: ' , ' }, TOOLS)).toThrow('--tools requires at least one scope')
  })

  it('rejects a scope the grammar cannot parse, naming the entry', () => {
    expect(() => planTokenIssue({ tools: 'tool:posts.*' }, TOOLS)).toThrow('Invalid tool scope "tool:posts.*"')
  })

  it('shows how a shorthand was read when rejecting it', () => {
    expect(() => planTokenIssue({ tools: 'posts store' }, TOOLS)).toThrow(
      'Invalid tool scope "posts store" (read as "tool:posts store")',
    )
  })

  it('refuses tools:* without --yes', () => {
    expect(() => planTokenIssue({ tools: '*' }, TOOLS)).toThrow('Re-run with --yes')
  })

  it('issues tools:* once confirmed', () => {
    const plan = planTokenIssue({ tools: '*', yes: true, expires: '1d' }, TOOLS)

    expect(plan.abilities).toEqual(['tools:*'])
    expect(plan.granted.readOnly).toEqual(['posts.index', 'posts.show'])
    expect(plan.granted.write).toEqual(['posts.store', 'comments.destroy'])
  })

  it('rejects a scope matching no current tool', () => {
    expect(() => planTokenIssue({ tools: 'posst.store' }, TOOLS)).toThrow(
      'Scope "tool:posst.store" matches none of this app\'s agent tools',
    )
  })

  it('rejects an unmatched prefix as readily as an unmatched name', () => {
    expect(() => planTokenIssue({ tools: 'billing.*' }, TOOLS)).toThrow(
      'Scope "tools:billing.*" matches none of this app\'s agent tools',
    )
  })

  it('grants an unmatched scope under --allow-unmatched, warning that it activates later', () => {
    const plan = planTokenIssue(
      { tools: 'posts.*, billing.*', allowUnmatched: true, expires: '1d' },
      TOOLS,
    )

    expect(plan.abilities).toEqual(['tools:posts.*', 'tools:billing.*'])
    expect(plan.warnings.some((warning) => warning.includes('"tools:billing.*" matches no tool today'))).toBe(true)
    expect(plan.warnings.some((warning) => warning.includes('no further consent'))).toBe(true)
  })

  describe('--read-only', () => {
    it('stores the concrete tools it resolved to, never the pattern', () => {
      const plan = planTokenIssue({ tools: 'posts.*', readOnly: true, expires: '1d' }, TOOLS)

      expect(plan.abilities).toEqual(['tool:posts.index', 'tool:posts.show'])
      expect(plan.granted.readOnly).toEqual(['posts.index', 'posts.show'])
      expect(plan.granted.write).toEqual([])
    })

    it('refuses a scope that resolves only to write tools', () => {
      // The name is real, so this is not a typo — it simply grants nothing
      // once the read-only filter applies, which is the same mistake.
      expect(() => planTokenIssue({ tools: 'comments.destroy', readOnly: true }, TOOLS)).toThrow(
        'Scope "tool:comments.destroy" matches no read-only tool',
      )
    })

    it('refuses a write-only entry rather than silently dropping it beside a good one', () => {
      // `posts.*` would carry the token on its own, so nothing here fails at
      // the aggregate level — the point is that `comments.*` contributes
      // nothing and the caller is told, instead of finding out from the
      // issued token's ability list.
      expect(() =>
        planTokenIssue({ tools: 'posts.*, comments.*', readOnly: true, expires: '1d' }, TOOLS),
      ).toThrow('Scope "tools:comments.*" matches no read-only tool')
    })

    it('refuses an unmatched scope even with --allow-unmatched', () => {
      // Concrete entries cannot activate later, so the flag's promise of
      // future activation is one this combination could never keep.
      expect(() =>
        planTokenIssue({ tools: 'posts.*, billing.*', readOnly: true, allowUnmatched: true }, TOOLS),
      ).toThrow('could never grant anything later')
    })

    it('never triggers the mixed read/write warning', () => {
      const plan = planTokenIssue({ tools: '*', readOnly: true, yes: true, expires: '1d' }, TOOLS)

      expect(plan.granted.write).toEqual([])
      expect(plan.warnings).toEqual([])
    })
  })

  describe('warnings', () => {
    it('warns when the token never expires but still issues it', () => {
      const plan = planTokenIssue({ tools: 'read' }, TOOLS)

      expect(plan.expiresIn).toBeNull()
      expect(plan.warnings.some((warning) => warning.includes('never expires'))).toBe(true)
    })

    it('warns about the lethal trifecta when read and write are granted together', () => {
      const plan = planTokenIssue({ tools: 'posts.*', expires: '1d' }, TOOLS)

      expect(plan.warnings.some((warning) => warning.includes('reads untrusted content'))).toBe(true)
    })

    it('stays quiet when the grant is write-only', () => {
      const plan = planTokenIssue({ tools: 'comments.destroy', expires: '1d' }, TOOLS)

      expect(plan.warnings).toEqual([])
    })
  })

  it('reports a bad --expires only after the scopes are settled', () => {
    // Ordering is part of the contract: the first thing wrong with the command
    // line should be the thing reported, and a typo'd tool name outranks a
    // typo'd duration.
    expect(() => planTokenIssue({ tools: 'nope.tool', expires: 'soon' }, TOOLS)).toThrow(
      'matches none of this app\'s agent tools',
    )
    expect(() => planTokenIssue({ tools: 'read', expires: 'soon' }, TOOLS)).toThrow('Invalid --expires value')
  })
})

describe('issueAgentToken', () => {
  it('writes a token carrying the planned abilities and expiry', async () => {
    const store = new MemoryApiTokenStore()
    const before = Date.now()

    const { plan, result } = await issueAgentToken(() => store, TOOLS, {
      name: 'ci-agent',
      userId: 42,
      tools: 'posts.*',
      readOnly: true,
      expires: '30d',
    })

    expect(plan.abilities).toEqual(['tool:posts.index', 'tool:posts.show'])
    expect(result.token.abilities).toEqual(['tool:posts.index', 'tool:posts.show'])
    expect(result.token.name).toBe('ci-agent')
    expect(result.token.userId).toBe(42)
    expect(store.size).toBe(1)

    const expiresAt = result.token.expiresAt!.getTime()
    expect(expiresAt).toBeGreaterThanOrEqual(before + 30 * 24 * 60 * 60_000)

    // `{id}|{plainToken}`, and the only time the plain half exists.
    expect(result.plainTextToken.startsWith(`${result.token.id}|`)).toBe(true)
  })

  it('issues a non-expiring token when --expires is omitted', async () => {
    const store = new MemoryApiTokenStore()

    const { result } = await issueAgentToken(() => store, TOOLS, {
      name: 'forever',
      userId: 'user_1',
      tools: 'read',
    })

    expect(result.token.expiresAt).toBeNull()
  })

  it('refuses an empty user ID, which citty accepts for a required flag', async () => {
    const store = new MemoryApiTokenStore()

    await expect(
      issueAgentToken(() => store, TOOLS, { name: 'a', userId: '', tools: 'read' }),
    ).rejects.toThrow('authenticates as nobody')

    expect(store.size).toBe(0)
  })

  it('refuses an empty name, which nothing could later identify for revocation', async () => {
    const store = new MemoryApiTokenStore()

    await expect(
      issueAgentToken(() => store, TOOLS, { name: '  ', userId: 1, tools: 'read' }),
    ).rejects.toThrow('--name requires a non-empty name')

    expect(store.size).toBe(0)
  })

  it('never reaches for the store when the plan is refused', async () => {
    const store = new MemoryApiTokenStore()
    let resolved = 0

    await expect(
      issueAgentToken(
        () => {
          resolved += 1
          return store
        },
        TOOLS,
        { name: 'bad', userId: 1, tools: 'posst.store' },
      ),
    ).rejects.toThrow('matches none of this app\'s agent tools')

    // Resolving the store means booting the application — a typo must not
    // cost that, let alone leave a half-written token behind.
    expect(resolved).toBe(0)
    expect(store.size).toBe(0)
  })
})

describe('parseUserId round-trip', () => {
  it('keeps a digit string that is not its own numeric spelling', () => {
    // `0042` and `42` are different ids in an app keyed by string; coercing
    // the first would mint for a principal nobody typed.
    expect(parseUserId('0042')).toBe('0042')
    expect(parseUserId('42')).toBe(42)
    expect(parseUserId('user-7')).toBe('user-7')
  })
})

describe('planTokenIssue reserved-word collision', () => {
  it('warns when the read shorthand shadows a tool literally named read', () => {
    const withRead: ScopedTool[] = [...TOOLS, { name: 'read', readOnly: false }]
    const plan = planTokenIssue({ tools: 'read' }, withRead)

    expect(plan.abilities).toEqual(['tools:read'])
    expect(plan.warnings.some((warning) => warning.includes('tool:read'))).toBe(true)
  })

  it('stays silent when no tool is named read', () => {
    const plan = planTokenIssue({ tools: 'read' }, TOOLS)
    expect(plan.warnings.some((warning) => warning.includes('tool:read'))).toBe(false)
  })
})
