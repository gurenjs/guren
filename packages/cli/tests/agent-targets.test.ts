import { describe, it, expect } from 'bun:test'
import {
  AGENT_TARGETS,
  BULK_TEMPLATE_PREFIXES,
  componentsForTargets,
  managedNamespaces,
  parseTargetList,
  planComponents,
  RETIRED_CANONICAL_RULES,
  RETIRED_CANONICAL_SKILLS,
  type HarnessComponent,
  type TemplateFiles,
} from '../src/agent-targets'
import { loadAgentTemplates } from '../src/agent-harness'

describe('parseTargetList', () => {
  it('parses a comma-separated list, trimming and deduping', () => {
    expect(parseTargetList('codex, cursor,codex')).toEqual(['codex', 'cursor'])
  })

  it('expands "all" to every target', () => {
    expect(parseTargetList('all')).toEqual([...AGENT_TARGETS])
  })

  it('is case-insensitive', () => {
    expect(parseTargetList('Claude,OPENCODE')).toEqual(['claude', 'opencode'])
  })

  it('throws on an unknown target instead of installing the default', () => {
    expect(() => parseTargetList('claud')).toThrow('Unknown agent target "claud"')
  })

  it('validates every entry even when "all" is present', () => {
    expect(() => parseTargetList('all,claud')).toThrow('Unknown agent target "claud"')
  })

  it('throws on an empty list', () => {
    expect(() => parseTargetList(' , ')).toThrow('No agent targets given')
  })
})

describe('componentsForTargets', () => {
  it('maps claude to the claude component only', () => {
    expect(componentsForTargets(['claude'])).toEqual(['claude'])
  })

  it('maps every non-claude target onto the shared agents family plus its native extras', () => {
    expect(componentsForTargets(['cursor'])).toEqual(['agents', 'cursor'])
    expect(componentsForTargets(['copilot'])).toEqual(['agents', 'copilot'])
  })

  it('adds the per-tool components for codex and opencode', () => {
    expect(componentsForTargets(['codex'])).toEqual(['agents', 'codex'])
    expect(componentsForTargets(['opencode'])).toEqual(['agents', 'opencode'])
  })

  it('combines claude with the agents family', () => {
    expect(componentsForTargets(['claude', 'codex'])).toEqual(['claude', 'agents', 'codex'])
  })
})

const FAKE_RULE = [
  '---',
  'description: Guren testing — TestApp client methods',
  'globs:',
  '  - "tests/**"',
  '  - "app/**"',
  '---',
  '',
  '# Testing',
  'rule body',
  '',
].join('\n')

function fakeTemplates(): TemplateFiles {
  return new Map([
    ['core/entry-intro.md', '# __APP_TITLE__ intro\n'],
    ['core/rules-catalog.md', 'rule catalog\n'],
    ['core/entry-body.md', 'body referencing __RULES_DIR__/testing.md\n'],
    ['core/rules/testing.md', FAKE_RULE],
    ['core/skills/scaffold/SKILL.md', 'rules live in `__RULES_DIR__/`'],
    ['targets/claude/workflow.md', 'claude hooks workflow\n'],
    ['targets/claude/mcp.json', '{}'],
    ['targets/claude/settings.json', '{}'],
    ['targets/claude/agents/code-review.md', 'agent'],
    ['targets/claude/hooks/check-after-edit.ts', 'hook'],
    ['core/hooks/gate-on-stop.ts', 'stop hook'],
    ['targets/cursor/hooks/gate-on-stop.ts', 'cursor stop hook'],
    ['targets/cursor/hooks.json', '{"hooks":{"stop":[{"command":"bun .cursor/hooks/gate-on-stop.ts"}]}}'],
    ['targets/codex/hooks.json', '{"hooks":{"Stop":[{"hooks":[{"command":"bun .codex/hooks/gate-on-stop.ts"}]}]}}'],
    ['targets/agents/workflow.md', 'manual workflow for __RULES_DIR__\n'],
    ['targets/codex/config.toml', '[mcp_servers.guren]'],
    ['targets/codex/rules/guren.rules', 'prefix_rule(...)'],
    ['targets/cursor/mcp.json', '{"mcpServers":{}}'],
    ['targets/copilot/mcp.json', '{"servers":{}}'],
    ['targets/opencode/opencode.json', '{"mcp":{}}'],
  ])
}

function planByPath(
  components: HarnessComponent[],
  templates: TemplateFiles = fakeTemplates(),
): Map<string, ReturnType<typeof planComponents>[number]> {
  return new Map(planComponents(components, templates, 'My App').map((file) => [file.path, file]))
}

describe('planComponents', () => {
  it('renders the claude-only plan with the fully assembled CLAUDE.md', () => {
    const byPath = planByPath(['claude'])

    expect(byPath.get('CLAUDE.md')?.content).toBe(
      '# My App intro\n\nclaude hooks workflow\n\nrule catalog\n\nbody referencing .claude/rules/testing.md\n',
    )
    expect(byPath.get('CLAUDE.md')?.managed).toBe(false)
    expect(byPath.get('.claude/rules/testing.md')?.managed).toBe(true)
    expect(byPath.get('.claude/skills/scaffold/SKILL.md')?.content).toBe(
      'rules live in `.claude/rules/`',
    )
    expect(byPath.has('AGENTS.md')).toBe(false)
    expect(byPath.has('.agents/rules/testing.md')).toBe(false)
  })

  it('assembles AGENTS.md from the same intro and body with the agents workflow', () => {
    const byPath = planByPath(['claude', 'agents'])

    expect(byPath.get('AGENTS.md')?.content).toBe(
      '# My App intro\n\nmanual workflow for .agents/rules\n\nrule catalog\n\nbody referencing .agents/rules/testing.md\n',
    )
    expect(byPath.get('CLAUDE.md')?.content).toContain('claude hooks workflow')
    expect(byPath.get('.agents/skills/scaffold/SKILL.md')?.content).toBe(
      'rules live in `.agents/rules/`',
    )
  })

  it('marks every MCP client config as user-owned with the endpoint merge marker', () => {
    const byPath = planByPath(['claude', 'agents', 'cursor', 'copilot', 'codex', 'opencode'])

    for (const path of [
      '.mcp.json',
      '.cursor/mcp.json',
      '.vscode/mcp.json',
      '.codex/config.toml',
      'opencode.json',
    ]) {
      expect(byPath.get(path)).toMatchObject({ managed: false, mergeMarker: '_guren/mcp' })
    }
  })

  it('plans the stop hook for the agents that can act on it, with a user-owned config', () => {
    const byPath = planByPath(['claude', 'agents', 'cursor', 'copilot', 'codex', 'opencode'])

    // One script and contract for Claude Code and Codex; Cursor's own for its followup_message contract.
    expect(byPath.get('.claude/hooks/gate-on-stop.ts')).toMatchObject({ content: 'stop hook', managed: true })
    expect(byPath.get('.codex/hooks/gate-on-stop.ts')).toMatchObject({ content: 'stop hook', managed: true })
    expect(byPath.get('.cursor/hooks/gate-on-stop.ts')).toMatchObject({ content: 'cursor stop hook', managed: true })
    for (const path of ['.cursor/hooks.json', '.codex/hooks.json']) {
      expect(byPath.get(path)).toMatchObject({ managed: false, mergeMarker: 'gate-on-stop', mergeHint: expect.stringContaining('stop hook') })
    }
    // Copilot and OpenCode have no turn-end hook that can feed output back.
    expect([...byPath.keys()].filter((path) => path.includes('hooks'))).toEqual(
      expect.not.arrayContaining(['.github/hooks/guren.json', '.opencode/plugins/guren.ts']),
    )
  })

  it('ships the codex command approval policy as plain user-owned (no merge marker)', () => {
    const byPath = planByPath(['agents', 'codex'])

    expect(byPath.get('.codex/rules/guren.rules')).toMatchObject({ managed: false })
    expect(byPath.get('.codex/rules/guren.rules')?.mergeMarker).toBeUndefined()
  })

  it('renders cursor rules as guren-prefixed .mdc with comma-joined globs', () => {
    const byPath = planByPath(['agents', 'cursor'])

    const rule = byPath.get('.cursor/rules/guren-testing.mdc')
    expect(rule?.managed).toBe(true)
    expect(rule?.content).toContain('description: Guren testing — TestApp client methods')
    expect(rule?.content).toContain('globs: tests/**,app/**')
    expect(rule?.content).toContain('alwaysApply: false')
    expect(rule?.content).toContain('# Testing')
  })

  it('renders copilot rules as guren-prefixed .instructions.md with applyTo', () => {
    const byPath = planByPath(['agents', 'copilot'])

    const rule = byPath.get('.github/instructions/guren-testing.instructions.md')
    expect(rule?.managed).toBe(true)
    expect(rule?.content).toContain('applyTo: "tests/**,app/**"')
    expect(rule?.content).toContain('# Testing')
    expect(rule?.content).not.toContain('alwaysApply')
  })

  it('parses rule frontmatter with CRLF line endings', () => {
    const templates = fakeTemplates()
    templates.set('core/rules/testing.md', FAKE_RULE.replaceAll('\n', '\r\n'))

    const rule = planByPath(['cursor'], templates).get('.cursor/rules/guren-testing.mdc')
    expect(rule?.content).toContain('globs: tests/**,app/**')
  })

  it('throws when a canonical rule is nested — no claim can reach one', () => {
    const templates = fakeTemplates()
    templates.delete('core/rules/testing.md')
    templates.set('core/rules/http/auth.md', FAKE_RULE)
    // the native projections would fold it into guren-http/auth.mdc, and prune claims scan
    // a directory's top level only
    expect(() => planComponents(['claude'], templates, 'My App')).toThrow(
      'Agent harness rule http/auth.md must be a flat file',
    )
  })

  it('throws when a rule file has no parseable frontmatter instead of shipping an empty scope', () => {
    const templates = fakeTemplates()
    templates.set('core/rules/testing.md', '# No frontmatter\n')
    expect(() => planComponents(['cursor'], templates, 'My App')).toThrow(
      'Agent harness rule testing.md needs a description and at least one glob',
    )
  })

  it('throws when a template token survives rendering', () => {
    const templates = fakeTemplates()
    templates.set('targets/claude/mcp.json', '{"oops": "__RULES_DIR__"}')
    expect(() => planComponents(['claude'], templates, 'My App')).toThrow(
      'Agent harness left __RULES_DIR__ unrendered in .mcp.json',
    )
  })

  it('throws when a canonical template file is missing', () => {
    const templates = fakeTemplates()
    templates.delete('core/entry-body.md')
    expect(() => planComponents(['agents'], templates, 'My App')).toThrow(
      'Agent harness template is missing core/entry-body.md',
    )
  })
})

const ALL_COMPONENTS: HarnessComponent[] = ['claude', 'agents', 'cursor', 'copilot', 'codex', 'opencode']

describe('managedNamespaces', () => {
  const plan = (components: HarnessComponent[]) =>
    planComponents(components, fakeTemplates(), 'My App')

  it('claims the rules and skills roots only by the names the harness ships', () => {
    // both roots are shared (skills with external installers, rules with the project's own
    // conventions), so a whole-root claim would prune files the framework never wrote
    expect(managedNamespaces(['claude', 'agents'], plan(['claude', 'agents']))).toEqual([
      { kind: 'files', dir: '.claude/rules', names: ['testing.md'] },
      { kind: 'children', dir: '.claude/skills', names: ['scaffold'] },
      { kind: 'files', dir: '.agents/rules', names: ['testing.md'] },
      { kind: 'children', dir: '.agents/skills', names: ['scaffold'] },
    ])
  })

  it('a retired skill name stays claimed alongside the planned ones', () => {
    const [, claude] = managedNamespaces(['claude'], plan(['claude']), { skills: ['old-skill'] })
    expect(claude).toEqual({
      kind: 'children',
      dir: '.claude/skills',
      names: ['old-skill', 'scaffold'],
    })
  })

  it('a retired rule name stays claimed alongside the planned ones', () => {
    const [claude] = managedNamespaces(['claude'], plan(['claude']), { rules: ['models.md'] })
    expect(claude).toEqual({
      kind: 'files',
      dir: '.claude/rules',
      names: ['models.md', 'testing.md'],
    })
  })

  it('rejects a retired name that is not a single path segment — the claim is rm-adjacent', () => {
    const claim = (bad: string) => () => managedNamespaces(['claude'], plan(['claude']), { skills: [bad] })
    // safePathSegments' rule in its own words, including the Windows separator and the NUL
    // that truncates a path syscall-side
    for (const bad of ['.', '..', '../x', 'a\\b', '..\\x', 'a\u0000b']) {
      expect(claim(bad)).toThrow('path traversal')
    }
    expect(claim('')).toThrow('required')
    // and the one constraint a claimed name adds on top of it
    expect(claim('a/b')).toThrow('not a single path segment')
    // the rule claim is rm-adjacent in the same way, and reports as one
    expect(() => managedNamespaces(['claude'], plan(['claude']), { rules: ['../x'] })).toThrow(
      'path traversal',
    )
    expect(() => managedNamespaces(['claude'], plan(['claude']), { rules: ['a/b'] })).toThrow(
      'Agent harness rule claim "a/b" is not a single path segment',
    )
  })

  it('the rule claim is derived from the plan, so it tracks the real templates', async () => {
    const real = planComponents(['claude'], await loadAgentTemplates(), 'My App')
    const [claude] = managedNamespaces(['claude'], real)
    if (claude.kind !== 'files') {
      throw new Error('expected a files claim')
    }
    // shipped ∪ retired: nothing can know a rule was dropped without a
    // tombstone in RETIRED_CANONICAL_RULES
    const shipped = real
      .filter((file) => file.path.startsWith('.claude/rules/'))
      .map((file) => file.path.slice('.claude/rules/'.length))
      .sort()
    expect(shipped).toContain('orm-models.md')
    expect(claude.names).toEqual([...new Set([...shipped, ...RETIRED_CANONICAL_RULES])].sort())
    for (const retired of RETIRED_CANONICAL_RULES) {
      expect(shipped).not.toContain(retired)
    }
  })

  it('the skill claim is derived from the plan, so it tracks the real templates', async () => {
    const real = planComponents(['claude'], await loadAgentTemplates(), 'My App')
    const [, claude] = managedNamespaces(['claude'], real)
    if (claude.kind !== 'children') {
      throw new Error('expected a children claim')
    }
    // the claim is exactly shipped ∪ retired. A dropped skill is caught by review of
    // core/skills/ removals, not here; what this pins is that a retired name never
    // returns as a shipped one, which would duplicate the tombstone claim.
    const shipped = [...new Set(real.filter((f) => f.path.startsWith('.claude/skills/')).map((f) => f.path.split('/')[2]))].sort()
    expect(claude.names).toEqual([...new Set([...shipped, ...RETIRED_CANONICAL_SKILLS])].sort())
    for (const retired of RETIRED_CANONICAL_SKILLS) {
      expect(shipped).not.toContain(retired)
    }
  })

  it('claims only guren-prefixed files in the shared cursor and copilot directories', () => {
    expect(managedNamespaces(['cursor', 'copilot'], plan(['cursor', 'copilot']))).toEqual([
      { kind: 'pattern', dir: '.cursor/rules', prefix: 'guren-', suffix: '.mdc' },
      { kind: 'pattern', dir: '.github/instructions', prefix: 'guren-', suffix: '.instructions.md' },
    ])
  })

  it('claims nothing for codex and opencode, whose distinct files are user-owned', () => {
    expect(managedNamespaces(['codex', 'opencode'], plan(['codex', 'opencode']))).toEqual([])
  })

  it('every planned file inside a shared namespace carries its ownership pattern', () => {
    // .cursor/rules and .github/instructions also hold user files, so an unclaimable
    // managed file would be orphaned on rename
    const allPlanned = planComponents(ALL_COMPONENTS, fakeTemplates(), 'My App')
    const namespaces = managedNamespaces(ALL_COMPONENTS, allPlanned).filter(
      (namespace) => namespace.kind === 'pattern',
    )
    for (const file of allPlanned) {
      for (const namespace of namespaces) {
        if (!file.path.startsWith(`${namespace.dir}/`)) {
          continue
        }
        const name = file.path.slice(namespace.dir.length + 1)
        if (file.managed) {
          expect(name).toStartWith(namespace.prefix)
          expect(name).toEndWith(namespace.suffix)
        } else {
          // a user-owned planned file must never match the prune pattern
          expect(name.startsWith(namespace.prefix) && name.endsWith(namespace.suffix)).toBe(false)
        }
      }
    }
  })
})

describe('template completeness', () => {
  it('every shipped template file is consumed by the planner', async () => {
    const templates = await loadAgentTemplates()
    // evidence, not declaration: a template added to the tree but never wired into
    // planComponents fails here instead of shipping uninstalled
    const used = new Set<string>()
    class RecordingTemplates extends Map<string, string> {
      override get(key: string): string | undefined {
        used.add(key)
        return super.get(key)
      }
    }

    planComponents(ALL_COMPONENTS, new RecordingTemplates(templates), 'Demo App')

    for (const path of templates.keys()) {
      const reachable =
        used.has(path) || BULK_TEMPLATE_PREFIXES.some((prefix) => path.startsWith(prefix))
      if (!reachable) {
        throw new Error(
          `${path} is neither get()-consumed by planComponents nor under a bulk prefix — ` +
            'it would never be installed. Wire it into planComponents (agent-targets.ts).',
        )
      }
    }
  })

  it('the full plan over the real templates assembles both entry documents in order', async () => {
    const templates = await loadAgentTemplates()
    const all = planComponents(ALL_COMPONENTS, templates, 'Demo App')
    const headings = (content: string | undefined): string[] =>
      (content ?? '').split('\n').filter((line) => line.startsWith('## '))

    const claudeMd = all.find((file) => file.path === 'CLAUDE.md')
    const agentsMd = all.find((file) => file.path === 'AGENTS.md')

    expect(claudeMd?.content).toContain('# Demo App')
    expect(claudeMd?.content).toContain('.claude/rules')
    expect(headings(claudeMd?.content)).toEqual([
      '## Overview',
      '## AI Agents: Start Here',
      '## Project Structure',
      '## Development Commands',
      '## MCP Server (AI Agent Integration)',
      '## Architecture Overview',
      '## Testing',
      '## Key Files',
    ])

    expect(agentsMd?.content).toContain('# Demo App')
    expect(agentsMd?.content).toContain('.agents/rules')
    expect(headings(agentsMd?.content)).toEqual([
      '## Overview',
      '## AI Agents: Start Here',
      '## Session Workflow',
      '## Project Structure',
      '## Development Commands',
      '## MCP Server (AI Agent Integration)',
      '## Architecture Overview',
      '## Testing',
      '## Key Files',
    ])
  })
})
