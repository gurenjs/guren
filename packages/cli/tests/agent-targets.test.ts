import { describe, it, expect } from 'bun:test'
import {
  AGENT_TARGETS,
  BULK_TEMPLATE_PREFIXES,
  NAMED_TEMPLATE_PATHS,
  componentsForTargets,
  parseTargetList,
  planComponents,
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
    ['core/entry-body.md', 'body referencing __RULES_DIR__/testing.md\n'],
    ['core/rules/testing.md', FAKE_RULE],
    ['core/skills/scaffold/SKILL.md', 'rules live in `__RULES_DIR__/`'],
    ['targets/claude/workflow.md', 'claude hooks workflow\n'],
    ['targets/claude/mcp.json', '{}'],
    ['targets/claude/settings.json', '{}'],
    ['targets/claude/agents/code-review.md', 'agent'],
    ['targets/claude/hooks/check-after-edit.ts', 'hook'],
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
      '# My App intro\n\nclaude hooks workflow\n\nbody referencing .claude/rules/testing.md\n',
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
      '# My App intro\n\nmanual workflow for .agents/rules\n\nbody referencing .agents/rules/testing.md\n',
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

describe('template completeness', () => {
  it('every shipped template file is reachable from the planner', async () => {
    const templates = await loadAgentTemplates()

    for (const path of NAMED_TEMPLATE_PATHS) {
      expect(templates.has(path)).toBe(true)
    }
    for (const path of templates.keys()) {
      const reachable =
        (NAMED_TEMPLATE_PATHS as readonly string[]).includes(path) ||
        BULK_TEMPLATE_PREFIXES.some((prefix) => path.startsWith(prefix))
      if (!reachable) {
        throw new Error(
          `${path} is neither in NAMED_TEMPLATE_PATHS nor under a bulk prefix — ` +
            'it would never be installed. Wire it into planComponents (agent-targets.ts).',
        )
      }
    }
  })

  it('the full plan over the real templates renders without leftovers or conflicts', async () => {
    const templates = await loadAgentTemplates()
    const all = planComponents(
      ['claude', 'agents', 'cursor', 'copilot', 'codex', 'opencode'],
      templates,
      'Demo App',
    )

    const claudeMd = all.find((file) => file.path === 'CLAUDE.md')
    const agentsMd = all.find((file) => file.path === 'AGENTS.md')
    expect(claudeMd?.content).toContain('# Demo App')
    expect(claudeMd?.content).toContain('.claude/rules')
    expect(agentsMd?.content).toContain('# Demo App')
    expect(agentsMd?.content).toContain('.agents/rules')
  })
})
