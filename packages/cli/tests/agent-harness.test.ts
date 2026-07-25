import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, rm, readFile, writeFile, access } from 'node:fs/promises'
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
