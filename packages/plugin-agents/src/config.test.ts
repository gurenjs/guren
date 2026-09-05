import { describe, test, expect } from 'bun:test'

import { defineAgentsConfig, validateAgentsConfig } from './config'

/**
 * The registration grammar (RFC 0017 §3). The scope rule itself lives in
 * `@guren/server`'s `classifyRegistrationScope` and is pinned there; what
 * these cases pin is that the config validator *asks* it, and that every
 * problem it reports names the agent it belongs to.
 */
describe('validateAgentsConfig', () => {
  test('should accept an exact tool scope', () => {
    const config = defineAgentsConfig({
      agents: {
        triager: { module: 'app/Agents/Triager.ts', export: 'Triager', scopes: ['tool:posts.index'] },
      },
    })
    expect(validateAgentsConfig(config)).toEqual([])
  })

  test('should accept tools:read', () => {
    const config = defineAgentsConfig({
      agents: {
        reader: { module: 'app/Agents/Reader.ts', export: 'Reader', scopes: ['tools:read'] },
      },
    })
    expect(validateAgentsConfig(config)).toEqual([])
  })

  test('should accept an agent that may call nothing, written explicitly', () => {
    const config = defineAgentsConfig({
      agents: { idle: { module: 'app/Agents/Idle.ts', export: 'Idle', scopes: [] } },
    })
    expect(validateAgentsConfig(config)).toEqual([])
  })

  test('should reject tools:* and name the agent it was written under', () => {
    const problems = validateAgentsConfig({
      agents: { triager: { module: 'app/Agents/Triager.ts', export: 'Triager', scopes: ['tools:*'] } },
    })
    expect(problems).toHaveLength(1)
    expect(problems[0]!.agent).toBe('triager')
    expect(problems[0]!.scope).toBe('tools:*')
    expect(problems[0]!.message).toContain('did not exist when this was written')
  })

  test('should reject a prefix grant', () => {
    const problems = validateAgentsConfig({
      agents: { triager: { module: 'app/Agents/Triager.ts', export: 'Triager', scopes: ['tools:posts.*'] } },
    })
    expect(problems).toHaveLength(1)
    expect(problems[0]!.scope).toBe('tools:posts.*')
    expect(problems[0]!.message).toContain('posts.* family')
  })

  test('should reject a bare tool name', () => {
    const problems = validateAgentsConfig({
      agents: { triager: { module: 'app/Agents/Triager.ts', export: 'Triager', scopes: ['posts.index'] } },
    })
    expect(problems).toHaveLength(1)
    expect(problems[0]!.scope).toBe('posts.index')
    expect(problems[0]!.message).toContain('Did you mean "tool:posts.index"?')
  })

  test('should report every offending scope, not only the first', () => {
    const problems = validateAgentsConfig({
      agents: {
        a: { module: 'app/Agents/A.ts', export: 'A', scopes: ['tools:*', 'posts.index'] },
        b: { module: 'app/Agents/B.ts', export: 'B', scopes: ['tools:posts.*'] },
      },
    })
    expect(problems.map((problem) => `${problem.agent}:${problem.scope}`)).toEqual([
      'a:tools:*',
      'a:posts.index',
      'b:tools:posts.*',
    ])
  })

  test('should reject two agents claiming one exported class', () => {
    const problems = validateAgentsConfig({
      agents: {
        first: { module: 'app/Agents/Triager.ts', export: 'Triager', scopes: [] },
        second: { module: 'app/Agents/Triager.ts', export: 'Triager', scopes: [] },
      },
    })
    expect(problems).toHaveLength(1)
    expect(problems[0]!.agent).toBe('second')
    expect(problems[0]!.message).toContain('already registered as "first"')
  })

  test('should reject a registration with no module or export', () => {
    const problems = validateAgentsConfig({
      agents: { broken: { module: '', export: '', scopes: [] } },
    })
    expect(problems.map((problem) => problem.message)).toEqual([
      expect.stringContaining('no `module`'),
      expect.stringContaining('no `export`'),
    ])
  })

  for (const name of ['bad:name', 'has space', 'dot.name', '']) {
    test(`should reject the agent name ${JSON.stringify(name)}`, () => {
      // The name is one half of `agent:<name>:<instance>`. A `:` in it makes
      // "a:b"/"c" and "a"/"b:c" the same principal — and approvals are
      // isolated by principal id.
      const problems = validateAgentsConfig({
        agents: { [name]: { module: 'app/Agents/A.ts', export: 'A', scopes: [] } },
      })
      expect(problems.map((problem) => problem.message)).toContainEqual(
        expect.stringContaining('not a usable agent name'),
      )
    })
  }

  test('should accept letters, digits, underscores and hyphens in a name', () => {
    expect(
      validateAgentsConfig({
        agents: { 'nightly_triager-2': { module: 'app/Agents/A.ts', export: 'A', scopes: [] } },
      }),
    ).toEqual([])
  })

  for (const limit of [Number.POSITIVE_INFINITY, Number.NaN, 0, -1, 1.5, '10' as never]) {
    test(`should reject budget.callsPerMinute of ${String(limit)}`, () => {
      // Infinity makes the window check unreachable and NaN makes every
      // comparison false: both leave an unattended agent unmetered while the
      // config reads as though it had a budget.
      const problems = validateAgentsConfig({
        agents: {
          greedy: {
            module: 'app/Agents/A.ts',
            export: 'A',
            scopes: [],
            budget: { callsPerMinute: limit },
          },
        },
      })
      expect(problems.map((problem) => problem.message)).toContainEqual(
        expect.stringContaining('callsPerMinute'),
      )
    })
  }

  test('should accept a whole positive callsPerMinute', () => {
    expect(
      validateAgentsConfig({
        agents: {
          thrifty: {
            module: 'app/Agents/A.ts',
            export: 'A',
            scopes: [],
            budget: { callsPerMinute: 5 },
          },
        },
      }),
    ).toEqual([])
  })

  test('should reject an omitted scopes array rather than assuming one', () => {
    const problems = validateAgentsConfig({
      agents: {
        // The shape a hand-written config produces when the key is forgotten.
        broken: { module: 'app/Agents/Broken.ts', export: 'Broken' } as never,
      },
    })
    expect(problems).toHaveLength(1)
    expect(problems[0]!.message).toContain('no `scopes` array')
  })
})
