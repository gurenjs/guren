import { describe, it, expect } from 'bun:test'
import {
  AGENT_TARGETS,
  componentsForTargets,
  parseTargetList,
  planComponents,
  type TemplateFiles,
} from '../src/agent-targets'

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

  it('throws on an empty list', () => {
    expect(() => parseTargetList(' , ')).toThrow('No agent targets given')
  })
})

describe('componentsForTargets', () => {
  it('maps claude to the claude component only', () => {
    expect(componentsForTargets(['claude'])).toEqual(['claude'])
  })

  it('maps every non-claude target onto the shared agents family', () => {
    expect(componentsForTargets(['cursor'])).toEqual(['agents'])
    expect(componentsForTargets(['copilot'])).toEqual(['agents'])
  })

  it('adds the per-tool components for codex and opencode', () => {
    expect(componentsForTargets(['codex'])).toEqual(['agents', 'codex'])
    expect(componentsForTargets(['opencode'])).toEqual(['agents', 'opencode'])
  })

  it('combines claude with the agents family', () => {
    expect(componentsForTargets(['claude', 'codex'])).toEqual(['claude', 'agents', 'codex'])
  })
})

function fakeTemplates(): TemplateFiles {
  return new Map([
    ['core/AGENTS.md', '# __APP_TITLE__ (agents)'],
    ['core/rules/testing.md', 'rule body'],
    ['core/skills/scaffold/SKILL.md', 'rules live in `__RULES_DIR__/`'],
    ['targets/claude/CLAUDE.md', '# __APP_TITLE__ (full)'],
    ['targets/claude/mcp.json', '{}'],
    ['targets/claude/settings.json', '{}'],
    ['targets/claude/agents/code-review.md', 'agent'],
    ['targets/claude/hooks/check-after-edit.ts', 'hook'],
    ['targets/codex/config.toml', '[mcp_servers.guren]'],
    ['targets/codex/rules/guren.rules', 'prefix_rule(...)'],
    ['targets/opencode/opencode.json', '{"mcp":{}}'],
  ])
}

describe('planComponents', () => {
  it('renders the claude-only plan with the full CLAUDE.md', () => {
    const files = planComponents(['claude'], fakeTemplates())
    const byPath = new Map(files.map((file) => [file.path, file]))

    expect(byPath.get('CLAUDE.md')?.content).toBe('# __APP_TITLE__ (full)')
    expect(byPath.get('CLAUDE.md')?.managed).toBe(false)
    expect(byPath.get('.claude/rules/testing.md')?.managed).toBe(true)
    expect(byPath.get('.claude/skills/scaffold/SKILL.md')?.content).toBe(
      'rules live in `.claude/rules/`',
    )
    expect(byPath.has('AGENTS.md')).toBe(false)
    expect(byPath.has('.agents/rules/testing.md')).toBe(false)
  })

  it('keeps the full CLAUDE.md next to AGENTS.md when both families are present', () => {
    const files = planComponents(['claude', 'agents'], fakeTemplates())
    const byPath = new Map(files.map((file) => [file.path, file]))

    expect(byPath.get('CLAUDE.md')?.content).toBe('# __APP_TITLE__ (full)')
    expect(byPath.get('AGENTS.md')?.managed).toBe(false)
    expect(byPath.get('.agents/skills/scaffold/SKILL.md')?.content).toBe(
      'rules live in `.agents/rules/`',
    )
    expect(byPath.get('.claude/skills/scaffold/SKILL.md')?.content).toBe(
      'rules live in `.claude/rules/`',
    )
  })

  it('marks the codex and opencode MCP configs as user-owned merge-hint files', () => {
    const files = planComponents(['agents', 'codex', 'opencode'], fakeTemplates())
    const byPath = new Map(files.map((file) => [file.path, file]))

    expect(byPath.get('.codex/config.toml')).toMatchObject({ managed: false, mergeHint: true })
    expect(byPath.get('opencode.json')).toMatchObject({ managed: false, mergeHint: true })
    expect(byPath.has('CLAUDE.md')).toBe(false)
    expect(byPath.has('.claude/rules/testing.md')).toBe(false)
  })

  it('ships the codex command approval policy as plain user-owned (no merge hint)', () => {
    const files = planComponents(['agents', 'codex'], fakeTemplates())
    const byPath = new Map(files.map((file) => [file.path, file]))

    expect(byPath.get('.codex/rules/guren.rules')).toMatchObject({ managed: false })
    expect(byPath.get('.codex/rules/guren.rules')?.mergeHint).toBeUndefined()
  })

  it('throws when a canonical template file is missing', () => {
    const templates = fakeTemplates()
    templates.delete('core/AGENTS.md')
    expect(() => planComponents(['agents'], templates)).toThrow(
      'Agent harness template is missing core/AGENTS.md',
    )
  })
})
