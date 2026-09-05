import { describe, test, expect } from 'bun:test'

import {
  AGENT_TOOL_NAME_PATTERN,
  classifyRegistrationScope,
  expandToolScopes,
  parseToolScope,
  scopesAllowTool,
  type ScopedTool,
} from './scopes'

const tools: ScopedTool[] = [
  { name: 'posts.index', readOnly: true },
  { name: 'posts.show', readOnly: true },
  { name: 'posts.store', readOnly: false },
  { name: 'posts', readOnly: true },
  { name: 'comments.store', readOnly: false },
]

describe('parseToolScope', () => {
  test('should parse a single-tool scope', () => {
    expect(parseToolScope('tool:posts.store')).toEqual({ kind: 'tool', name: 'posts.store' })
  })

  test('should parse the read-only keyword', () => {
    expect(parseToolScope('tools:read')).toEqual({ kind: 'read' })
  })

  test('should parse the all-tools wildcard', () => {
    expect(parseToolScope('tools:*')).toEqual({ kind: 'all' })
  })

  test('should parse a prefix scope without its trailing wildcard', () => {
    expect(parseToolScope('tools:posts.*')).toEqual({ kind: 'prefix', prefix: 'posts' })
  })

  test('should treat a read-prefixed family as a prefix scope, not the keyword', () => {
    expect(parseToolScope('tools:read.*')).toEqual({ kind: 'prefix', prefix: 'read' })
  })

  test('should return null for entries that are not tool scopes', () => {
    expect(parseToolScope('*')).toBeNull()
    expect(parseToolScope('posts.store')).toBeNull()
    expect(parseToolScope('server:read')).toBeNull()
    expect(parseToolScope('')).toBeNull()
  })

  test('should return null for an empty name or set', () => {
    expect(parseToolScope('tool:')).toBeNull()
    expect(parseToolScope('tools:')).toBeNull()
    expect(parseToolScope('tools:.*')).toBeNull()
  })

  test('should reject a wildcard that is not the whole trailing segment', () => {
    expect(parseToolScope('tools:*.store')).toBeNull()
    expect(parseToolScope('tools:posts.*.x')).toBeNull()
    expect(parseToolScope('tools:*.')).toBeNull()
    expect(parseToolScope('tools:a*b.*')).toBeNull()
  })

  test('should reject a single-tool scope naming an illegal tool name', () => {
    expect(parseToolScope('tool:posts.*')).toBeNull()
    expect(parseToolScope('tool:posts store')).toBeNull()
    expect(parseToolScope('tool:posts/store')).toBeNull()
    expect(parseToolScope(`tool:${'a'.repeat(129)}`)).toBeNull()
  })

  test('should accept a tool name at the length cap', () => {
    const name = 'a'.repeat(128)
    expect(parseToolScope(`tool:${name}`)).toEqual({ kind: 'tool', name })
  })

  test('should reject a prefix outside the tool-name grammar', () => {
    expect(parseToolScope('tools:po sts.*')).toBeNull()
    expect(parseToolScope(`tools:${'a'.repeat(129)}.*`)).toBeNull()
  })

  test('should not trim or case-fold entries', () => {
    expect(parseToolScope(' tool:posts.show')).toBeNull()
    expect(parseToolScope('TOOL:posts.show')).toBeNull()
    expect(parseToolScope('tools:READ')).toBeNull()
  })

  test('should keep the exported tool-name pattern in agreement with the grammar', () => {
    expect(AGENT_TOOL_NAME_PATTERN.test('posts.store')).toBe(true)
    expect(AGENT_TOOL_NAME_PATTERN.test('posts-store_2')).toBe(true)
    expect(AGENT_TOOL_NAME_PATTERN.test('posts *')).toBe(false)
    expect(AGENT_TOOL_NAME_PATTERN.test('')).toBe(false)
  })
})

describe('scopesAllowTool', () => {
  const store: ScopedTool = { name: 'posts.store', readOnly: false }
  const show: ScopedTool = { name: 'posts.show', readOnly: true }

  test('should deny when abilities are empty', () => {
    expect(scopesAllowTool([], show)).toBe(false)
    expect(scopesAllowTool([], store)).toBe(false)
  })

  test('should deny the ApiToken default abilities', () => {
    expect(scopesAllowTool(['*'], show)).toBe(false)
    expect(scopesAllowTool(['*'], store)).toBe(false)
  })

  test('should deny abilities that are an application own vocabulary', () => {
    expect(scopesAllowTool(['posts:write', 'admin'], store)).toBe(false)
  })

  test('should allow an exactly named tool only', () => {
    expect(scopesAllowTool(['tool:posts.store'], store)).toBe(true)
    expect(scopesAllowTool(['tool:posts.store'], show)).toBe(false)
  })

  test('should allow every tool under tools:*', () => {
    expect(scopesAllowTool(['tools:*'], store)).toBe(true)
    expect(scopesAllowTool(['tools:*'], show)).toBe(true)
  })

  test('should allow read-only tools under tools:read', () => {
    expect(scopesAllowTool(['tools:read'], show)).toBe(true)
    expect(scopesAllowTool(['tools:read'], store)).toBe(false)
  })

  test('should require the dot when matching a prefix scope', () => {
    expect(scopesAllowTool(['tools:posts.*'], store)).toBe(true)
    expect(scopesAllowTool(['tools:posts.*'], { name: 'posts', readOnly: true })).toBe(false)
    expect(scopesAllowTool(['tools:posts.*'], { name: 'postsx.show', readOnly: true })).toBe(false)
  })

  test('should ignore malformed entries while honoring valid ones beside them', () => {
    expect(scopesAllowTool(['tools:*.store', 'tool:posts.store'], store)).toBe(true)
    expect(scopesAllowTool(['tools:*.store', 'tools:'], store)).toBe(false)
  })

  test('should allow when any single entry matches', () => {
    expect(scopesAllowTool(['*', 'tool:posts.show'], show)).toBe(true)
    expect(scopesAllowTool(['*', 'tool:posts.show'], store)).toBe(false)
  })
})

describe('expandToolScopes', () => {
  test('should expand to nothing for empty abilities', () => {
    expect(expandToolScopes([], tools)).toEqual([])
  })

  test('should expand the ApiToken default abilities to nothing', () => {
    expect(expandToolScopes(['*'], tools)).toEqual([])
  })

  test('should expand tools:* to every tool, in input order', () => {
    expect(expandToolScopes(['tools:*'], tools)).toEqual([
      'posts.index',
      'posts.show',
      'posts.store',
      'posts',
      'comments.store',
    ])
  })

  test('should expand tools:read to the read-only tools', () => {
    expect(expandToolScopes(['tools:read'], tools)).toEqual([
      'posts.index',
      'posts.show',
      'posts',
    ])
  })

  test('should expand a prefix scope to that family only', () => {
    expect(expandToolScopes(['tools:posts.*'], tools)).toEqual([
      'posts.index',
      'posts.show',
      'posts.store',
    ])
  })

  test('should union several entries without repeating a tool', () => {
    expect(expandToolScopes(['tools:read', 'tool:comments.store'], tools)).toEqual([
      'posts.index',
      'posts.show',
      'posts',
      'comments.store',
    ])
  })

  test('should expand a scope that can never match to nothing', () => {
    expect(expandToolScopes([`tools:${'a'.repeat(128)}.*`], tools)).toEqual([])
  })

  test('should agree with scopesAllowTool on every tool', () => {
    const abilities = ['*', 'tools:read', 'tool:comments.store', 'tools:*.store']
    const expanded = expandToolScopes(abilities, tools)

    for (const tool of tools) {
      expect(expanded.includes(tool.name)).toBe(scopesAllowTool(abilities, tool))
    }
  })
})

/**
 * The narrower half of the grammar, shared by `@guren/plugin-agents`'
 * `validateAgentsConfig` and `guren check`'s agents-config check (RFC 0017
 * §3). Both read this one function, so these cases are the only place the
 * registration rule is pinned.
 */
describe('classifyRegistrationScope', () => {
  test('should accept a single tool by exact name', () => {
    expect(classifyRegistrationScope('tool:posts.index')).toEqual({
      allowed: true,
      scope: { kind: 'tool', name: 'posts.index' },
    })
  })

  test('should accept tools:read, the one promise about tools rather than a list of them', () => {
    expect(classifyRegistrationScope('tools:read')).toEqual({
      allowed: true,
      scope: { kind: 'read' },
    })
  })

  test('should reject tools:* even though the token grammar understands it', () => {
    // The whole point of the narrower rule: `parseToolScope` reads this fine,
    // and a registration still may not carry it.
    expect(parseToolScope('tools:*')).toEqual({ kind: 'all' })

    const verdict = classifyRegistrationScope('tools:*')
    expect(verdict.allowed).toBe(false)
    if (verdict.allowed) return
    expect(verdict.reason).toBe('wildcard')
    expect(verdict.message).toContain('tools:*')
    expect(verdict.message).toContain('did not exist when this was written')
  })

  test('should reject a prefix grant and name the family it would have granted', () => {
    const verdict = classifyRegistrationScope('tools:posts.*')
    expect(verdict.allowed).toBe(false)
    if (verdict.allowed) return
    expect(verdict.reason).toBe('prefix')
    expect(verdict.message).toContain('posts.* family')
  })

  test('should reject a bare tool name and suggest the tool: spelling', () => {
    const verdict = classifyRegistrationScope('posts.index')
    expect(verdict.allowed).toBe(false)
    if (verdict.allowed) return
    expect(verdict.reason).toBe('not-a-tool-scope')
    expect(verdict.message).toContain('Did you mean "tool:posts.index"?')
  })

  test('should not suggest a spelling for an entry that already tried to be a scope', () => {
    const verdict = classifyRegistrationScope('tool:posts.*')
    expect(verdict.allowed).toBe(false)
    if (verdict.allowed) return
    expect(verdict.reason).toBe('not-a-tool-scope')
    expect(verdict.message).not.toContain('Did you mean')
  })

  test('should reject the store default ability, which grants no tool at all', () => {
    expect(classifyRegistrationScope('*').allowed).toBe(false)
  })
})
