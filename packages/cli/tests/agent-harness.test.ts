import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, mkdir, rm, readFile, writeFile, access } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { installAgentHarness } from '../src/agent-harness'

describe('installAgentHarness', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'guren-agent-harness-test-'))
    await writeFile(join(tempDir, 'package.json'), JSON.stringify({ name: 'my-app' }), 'utf8')
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('init writes the full harness with app title replaced', async () => {
    const result = await installAgentHarness({ cwd: tempDir, mode: 'init' })

    expect(result.skipped).toEqual([])
    expect(result.written).toContain('CLAUDE.md')
    expect(result.written).toContain('.mcp.json')
    expect(result.written).toContain('.claude/settings.json')
    expect(result.written).toContain('.claude/hooks/check-after-edit.ts')
    expect(result.written).toContain('.claude/rules/orm-models.md')
    expect(result.written).toContain('.claude/rules/docs-and-spec.md')
    expect(result.written).toContain('.claude/skills/dev-workflow/SKILL.md')
    expect(result.written).toContain('.claude/agents/code-review.md')

    const claudeMd = await readFile(join(tempDir, 'CLAUDE.md'), 'utf8')
    expect(claudeMd).toContain('# My App')
    expect(claudeMd).not.toContain('__APP_TITLE__')

    const settings = JSON.parse(await readFile(join(tempDir, '.claude/settings.json'), 'utf8')) as {
      hooks?: Record<string, unknown>
    }
    expect(settings.hooks?.SessionStart).toBeDefined()
    expect(settings.hooks?.PostToolUse).toBeDefined()
  })

  it('init derives the title from the directory name without package.json', async () => {
    await rm(join(tempDir, 'package.json'))
    await installAgentHarness({ cwd: tempDir, mode: 'init' })

    const claudeMd = await readFile(join(tempDir, 'CLAUDE.md'), 'utf8')
    expect(claudeMd).not.toContain('__APP_TITLE__')
  })

  it('init skips existing files', async () => {
    await writeFile(join(tempDir, 'CLAUDE.md'), '# Customized\n', 'utf8')

    const result = await installAgentHarness({ cwd: tempDir, mode: 'init' })

    expect(result.skipped).toEqual(['CLAUDE.md'])
    expect(await readFile(join(tempDir, 'CLAUDE.md'), 'utf8')).toBe('# Customized\n')
  })

  it('init --force overwrites existing files', async () => {
    await writeFile(join(tempDir, 'CLAUDE.md'), '# Customized\n', 'utf8')

    const result = await installAgentHarness({ cwd: tempDir, mode: 'init', force: true })

    expect(result.skipped).toEqual([])
    expect(await readFile(join(tempDir, 'CLAUDE.md'), 'utf8')).toContain('# My App')
  })

  it('sync refreshes managed files but preserves user-owned files', async () => {
    await installAgentHarness({ cwd: tempDir, mode: 'init' })

    await writeFile(join(tempDir, 'CLAUDE.md'), '# Customized\n', 'utf8')
    await writeFile(join(tempDir, '.claude/settings.json'), '{"custom":true}\n', 'utf8')
    await writeFile(join(tempDir, '.claude/rules/orm-models.md'), 'stale\n', 'utf8')

    const result = await installAgentHarness({ cwd: tempDir, mode: 'sync' })

    expect(result.written).toContain('.claude/rules/orm-models.md')
    expect(result.skipped).toContain('CLAUDE.md')
    expect(result.skipped).toContain('.claude/settings.json')

    expect(await readFile(join(tempDir, 'CLAUDE.md'), 'utf8')).toBe('# Customized\n')
    expect(await readFile(join(tempDir, '.claude/settings.json'), 'utf8')).toBe('{"custom":true}\n')
    expect(await readFile(join(tempDir, '.claude/rules/orm-models.md'), 'utf8')).not.toBe('stale\n')
  })

  it('sync writes user-owned files when missing', async () => {
    const result = await installAgentHarness({ cwd: tempDir, mode: 'sync' })

    expect(result.written).toContain('CLAUDE.md')
    expect(result.written).toContain('.claude/settings.json')
    await access(join(tempDir, '.mcp.json'))
  })

  it('init --target codex writes the agents family without any claude files', async () => {
    const result = await installAgentHarness({ cwd: tempDir, mode: 'init', targets: ['codex'] })

    expect(result.written).toContain('AGENTS.md')
    expect(result.written).toContain('.agents/rules/orm-models.md')
    expect(result.written).toContain('.agents/skills/dev-workflow/SKILL.md')
    expect(result.written).toContain('.codex/config.toml')
    expect(result.written).toContain('.codex/rules/guren.rules')
    expect(result.written).not.toContain('CLAUDE.md')
    expect(result.written.some((path) => path.startsWith('.claude/'))).toBe(false)

    const agentsMd = await readFile(join(tempDir, 'AGENTS.md'), 'utf8')
    expect(agentsMd).toContain('# My App')
    expect(agentsMd).toContain('.agents/rules/')

    const skill = await readFile(join(tempDir, '.agents/skills/scaffold/SKILL.md'), 'utf8')
    expect(skill).toContain('.agents/rules')
    expect(skill).not.toContain('__RULES_DIR__')
  })

  it('init --target claude,codex writes both trees, each with its full entry doc', async () => {
    const result = await installAgentHarness({
      cwd: tempDir,
      mode: 'init',
      targets: ['claude', 'codex'],
    })

    expect(result.written).toContain('CLAUDE.md')
    expect(result.written).toContain('AGENTS.md')
    expect(result.written).toContain('.claude/rules/orm-models.md')
    expect(result.written).toContain('.agents/rules/orm-models.md')

    // Claude Code does not read AGENTS.md, so CLAUDE.md stays the full guide
    const claudeMd = await readFile(join(tempDir, 'CLAUDE.md'), 'utf8')
    expect(claudeMd).toContain('# My App')
    expect(claudeMd).toContain('.claude/rules')
    expect(claudeMd).not.toContain('@AGENTS.md')

    const claudeSkill = await readFile(join(tempDir, '.claude/skills/scaffold/SKILL.md'), 'utf8')
    expect(claudeSkill).toContain('.claude/rules')
    expect(claudeSkill).not.toContain('__RULES_DIR__')
  })

  it('init --target cursor renders native .mdc rules next to the agents family', async () => {
    const result = await installAgentHarness({ cwd: tempDir, mode: 'init', targets: ['cursor'] })

    expect(result.written).toContain('AGENTS.md')
    expect(result.written).toContain('.cursor/rules/guren-testing.mdc')
    expect(result.written).toContain('.cursor/mcp.json')

    const rule = await readFile(join(tempDir, '.cursor/rules/guren-testing.mdc'), 'utf8')
    expect(rule).toContain('globs: tests/**')
    expect(rule).toContain('alwaysApply: false')
    expect(rule).toContain('TestApp')
  })

  it('init --target copilot renders native .instructions.md rules', async () => {
    const result = await installAgentHarness({ cwd: tempDir, mode: 'init', targets: ['copilot'] })

    expect(result.written).toContain('.github/instructions/guren-orm-models.instructions.md')
    expect(result.written).toContain('.vscode/mcp.json')

    const rule = await readFile(
      join(tempDir, '.github/instructions/guren-orm-models.instructions.md'),
      'utf8',
    )
    expect(rule).toContain('applyTo: "app/Models/**,db/**"')
    expect(rule).toContain('defineModel')
  })

  it('sync refreshes detected cursor rules without touching other families', async () => {
    await installAgentHarness({ cwd: tempDir, mode: 'init', targets: ['cursor'] })
    await writeFile(join(tempDir, '.cursor/rules/guren-testing.mdc'), 'stale\n', 'utf8')

    const result = await installAgentHarness({ cwd: tempDir, mode: 'sync' })

    expect(result.written).toContain('.cursor/rules/guren-testing.mdc')
    expect(await readFile(join(tempDir, '.cursor/rules/guren-testing.mdc'), 'utf8')).not.toBe('stale\n')
    expect(result.written.some((path) => path.startsWith('.claude/'))).toBe(false)
    expect(result.written.some((path) => path.startsWith('.github/'))).toBe(false)
  })

  it('sync ignores a hand-authored .agents/rules directory holding no managed files', async () => {
    await mkdir(join(tempDir, '.agents/rules'), { recursive: true })
    await writeFile(join(tempDir, '.agents/rules/my-conventions.md'), 'user rule\n', 'utf8')

    const result = await installAgentHarness({ cwd: tempDir, mode: 'sync' })

    expect(result.written).not.toContain('AGENTS.md')
    expect(result.written.some((path) => path.startsWith('.agents/'))).toBe(false)
    expect(await readFile(join(tempDir, '.agents/rules/my-conventions.md'), 'utf8')).toBe('user rule\n')
  })

  it('sync does not mistake user-authored cursor rules for an installed harness', async () => {
    await mkdir(join(tempDir, '.cursor/rules'), { recursive: true })
    await writeFile(join(tempDir, '.cursor/rules/my-style.mdc'), 'user rule\n', 'utf8')

    const result = await installAgentHarness({ cwd: tempDir, mode: 'sync' })

    // no guren-* evidence → falls back to the claude default, leaves .cursor alone
    expect(result.written.some((path) => path.startsWith('.cursor/'))).toBe(false)
    expect(result.written).toContain('.claude/rules/orm-models.md')
  })

  it('init --target opencode leaves an existing opencode.json alone and reports the snippet', async () => {
    await writeFile(join(tempDir, 'opencode.json'), '{"theme":"dark"}\n', 'utf8')

    const result = await installAgentHarness({ cwd: tempDir, mode: 'init', targets: ['opencode'] })

    expect(result.skipped).toContain('opencode.json')
    expect(await readFile(join(tempDir, 'opencode.json'), 'utf8')).toBe('{"theme":"dark"}\n')
    expect(result.mcpMergeHints).toHaveLength(1)
    expect(result.mcpMergeHints[0]?.path).toBe('opencode.json')
    expect(result.mcpMergeHints[0]?.snippet).toContain('_guren/mcp')
  })

  it('stays quiet about an existing MCP config that already has the endpoint', async () => {
    await mkdir(join(tempDir, '.codex'), { recursive: true })
    await writeFile(
      join(tempDir, '.codex/config.toml'),
      '[mcp_servers.guren]\nurl = "http://localhost:3333/_guren/mcp"\n',
      'utf8',
    )

    const result = await installAgentHarness({ cwd: tempDir, mode: 'init', targets: ['codex'] })

    expect(result.skipped).toContain('.codex/config.toml')
    expect(result.mcpMergeHints).toEqual([])
  })

  it('sync refreshes the installed family without inventing the other one', async () => {
    await installAgentHarness({ cwd: tempDir, mode: 'init', targets: ['codex'] })
    await writeFile(join(tempDir, '.agents/rules/orm-models.md'), 'stale\n', 'utf8')

    const result = await installAgentHarness({ cwd: tempDir, mode: 'sync' })

    expect(result.written).toContain('.agents/rules/orm-models.md')
    expect(await readFile(join(tempDir, '.agents/rules/orm-models.md'), 'utf8')).not.toBe('stale\n')
    expect(result.written.some((path) => path.startsWith('.claude/'))).toBe(false)
    expect(result.written).not.toContain('CLAUDE.md')
    // the user-owned MCP snippet is not re-planned by a detected sync,
    // so a deleted .codex/config.toml stays deleted
    expect(result.written).not.toContain('.codex/config.toml')
  })

  it('reports that .mcp.json is dead when no script enables the endpoint', async () => {
    await writeFile(
      join(tempDir, 'package.json'),
      JSON.stringify({ name: 'my-app', scripts: { dev: 'bun run codegen && bun run dev:server' } }),
      'utf8',
    )

    const result = await installAgentHarness({ cwd: tempDir, mode: 'init' })

    expect(result.mcpEndpointNotEnabled).toBe(true)
  })

  it('stays quiet when a script already enables the endpoint', async () => {
    await writeFile(
      join(tempDir, 'package.json'),
      JSON.stringify({
        name: 'my-app',
        scripts: { dev: 'bun run codegen && GUREN_MCP=1 bun run dev:server' },
      }),
      'utf8',
    )

    const result = await installAgentHarness({ cwd: tempDir, mode: 'init' })

    expect(result.mcpEndpointNotEnabled).toBe(false)
  })
})
