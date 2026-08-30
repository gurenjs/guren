import { describe, test, expect } from 'bun:test'

import {
  AGENT_TOOL_NAME_PATTERN,
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
