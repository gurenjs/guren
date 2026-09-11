import { describe, expect, test } from 'bun:test'

import { AGENT_TOOL_NAME_PATTERN } from './scopes'
import {
  isReservedAgentToolName,
  PORTABLE_AGENT_TOOL_NAME_PATTERN,
  RESERVED_AGENT_TOOL_NAMES,
} from './meta-tools'

describe('meta-tool names', () => {
  // #787: Claude Managed Agents skipped `guren.preflight` outright, and an
  // application has no `toolName` override for a name the framework chose.
  test('every reserved name is accepted by every known client', () => {
    for (const name of RESERVED_AGENT_TOOL_NAMES) {
      expect(name).toMatch(PORTABLE_AGENT_TOOL_NAME_PATTERN)
    }
  })

  test('the portable grammar is a strict subset of the MCP grammar', () => {
    for (const name of ['posts_index', 'a', 'x'.repeat(64), 'Mixed-Case_1']) {
      expect(name).toMatch(PORTABLE_AGENT_TOOL_NAME_PATTERN)
      expect(name).toMatch(AGENT_TOOL_NAME_PATTERN)
    }
    for (const name of ['posts.index', 'x'.repeat(65)]) {
      expect(name).not.toMatch(PORTABLE_AGENT_TOOL_NAME_PATTERN)
      expect(name).toMatch(AGENT_TOOL_NAME_PATTERN)
    }
  })

  test('reservation is by exact name', () => {
    expect(isReservedAgentToolName('guren_preflight')).toBe(true)
    expect(isReservedAgentToolName('guren.preflight')).toBe(false)
    expect(isReservedAgentToolName('Guren_Preflight')).toBe(false)
  })
})
