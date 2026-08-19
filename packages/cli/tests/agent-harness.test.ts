import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, mkdir, rm, readFile, rename, symlink, writeFile, access } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { findStaleManagedFiles, installAgentHarness, loadAgentTemplates } from '../src/agent-harness'
import { AGENT_TARGETS, planComponents } from '../src/agent-targets'

/**
 * Whether `dir` lives on a case-insensitive filesystem. Probed rather than
 * inferred from `process.platform`: macOS mounts case-sensitive volumes and
 * Linux case-insensitive ones, and the behavior under test follows the
 * filesystem the app was scaffolded on, not the OS running the test.
 */
async function filesystemIsCaseInsensitive(dir: string): Promise<boolean> {
  const probe = join(dir, 'case-probe.tmp')
  await writeFile(probe, '', 'utf8')
  try {
    await access(join(dir, 'CASE-PROBE.TMP'))
    return true
  } catch {
    return false
  } finally {
    await rm(probe, { force: true })
  }
}

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

  it('sync recreates a deleted .agents tree when native cursor rules remain', async () => {
    await installAgentHarness({ cwd: tempDir, mode: 'init', targets: ['cursor'] })
    await rm(join(tempDir, '.agents'), { recursive: true, force: true })

    const result = await installAgentHarness({ cwd: tempDir, mode: 'sync' })

    // cursor evidence implies the agents family it depends on
    expect(result.written).toContain('.agents/rules/orm-models.md')
    expect(result.written).toContain('.agents/skills/dev-workflow/SKILL.md')
    expect(result.skipped).toContain('AGENTS.md')
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

  /**
   * Simulate an install from an older release whose canonical rule carried a
   * different name: rename the rule's copies in whichever managed roots the
   * install produced.
   */
  const renameInstalledRule = async (from: string, to: string): Promise<void> => {
    const spellings = [
      [`.claude/rules/${from}.md`, `.claude/rules/${to}.md`],
      [`.agents/rules/${from}.md`, `.agents/rules/${to}.md`],
      [`.cursor/rules/guren-${from}.mdc`, `.cursor/rules/guren-${to}.mdc`],
      [
        `.github/instructions/guren-${from}.instructions.md`,
        `.github/instructions/guren-${to}.instructions.md`,
      ],
    ]
    for (const [oldPath, newPath] of spellings) {
      await rename(join(tempDir, oldPath), join(tempDir, newPath)).catch(() => {})
    }
  }

  it('sync reports what a renamed canonical rule left behind without deleting it', async () => {
    await installAgentHarness({ cwd: tempDir, mode: 'init', targets: ['claude', 'cursor'] })
    await renameInstalledRule('orm-models', 'models')

    const result = await installAgentHarness({ cwd: tempDir, mode: 'sync' })

    expect(result.stale).toEqual([
      '.agents/rules/models.md',
      '.claude/rules/models.md',
      '.cursor/rules/guren-models.mdc',
    ])
    expect(result.pruned).toBe(false)
    // the current name is restored, the old copies stay until an explicit --prune
    expect(result.written).toContain('.claude/rules/orm-models.md')
    await access(join(tempDir, '.claude/rules/models.md'))
    await access(join(tempDir, '.cursor/rules/guren-models.mdc'))
  })

  it('sync --prune deletes the renamed rule leftovers in every root', async () => {
    await installAgentHarness({ cwd: tempDir, mode: 'init', targets: ['claude', 'cursor', 'copilot'] })
    await renameInstalledRule('orm-models', 'models')

    const result = await installAgentHarness({ cwd: tempDir, mode: 'sync', prune: true })

    expect(result.pruned).toBe(true)
    expect(result.stale).toEqual([
      '.agents/rules/models.md',
      '.claude/rules/models.md',
      '.cursor/rules/guren-models.mdc',
      '.github/instructions/guren-models.instructions.md',
    ])
    await expect(access(join(tempDir, '.claude/rules/models.md'))).rejects.toThrow()
    await expect(access(join(tempDir, '.cursor/rules/guren-models.mdc'))).rejects.toThrow()
    // the rule under its current name is freshly written, not pruned
    expect(await readFile(join(tempDir, '.cursor/rules/guren-orm-models.mdc'), 'utf8')).toContain(
      'defineModel',
    )
  })

  it('sync claims a retired canonical skill the plan no longer writes', async () => {
    // "retired" is a name the framework used to ship — recorded in
    // RETIRED_CANONICAL_SKILLS, injected here because that list is empty
    // today. Driven through findStaleManagedFiles rather than the installer:
    // the seam for an empty constant belongs on an internal function, not on
    // the published options type. What prune then does with a stale file is
    // the shared machinery the retired-rule test above already pins.
    await installAgentHarness({ cwd: tempDir, mode: 'init' })
    await mkdir(join(tempDir, '.claude/skills/retired-skill'), { recursive: true })
    await writeFile(join(tempDir, '.claude/skills/retired-skill/SKILL.md'), 'old skill\n', 'utf8')

    const plan = planComponents(['claude'], await loadAgentTemplates(), 'My App')
    const stale = await findStaleManagedFiles(tempDir, ['claude'], plan, ['retired-skill'])

    expect(stale).toEqual(['.claude/skills/retired-skill/SKILL.md'])
    // and without the tombstone the same directory is not claimed at all
    expect(await findStaleManagedFiles(tempDir, ['claude'], plan)).toEqual([])
  })

  it('sync never claims a skill the framework did not write — the skills roots are shared with external installers', async () => {
    // `npx skills add` and Agent Plugins clients copy third-party skills flat
    // into these same directories; before the `children` claim every one of
    // them was a prune candidate, including Guren's own catalog skills
    await installAgentHarness({ cwd: tempDir, mode: 'init', targets: ['claude', 'codex'] })
    for (const dir of ['.claude/skills/guren-new-app', '.agents/skills/guren-new-app', '.agents/skills/some-vendor-skill']) {
      await mkdir(join(tempDir, dir, 'references'), { recursive: true })
      await writeFile(join(tempDir, dir, 'SKILL.md'), 'external skill\n', 'utf8')
      await writeFile(join(tempDir, dir, 'references/notes.md'), 'nested\n', 'utf8')
    }

    const reported = await installAgentHarness({ cwd: tempDir, mode: 'sync' })
    expect(reported.stale).toEqual([])

    const pruned = await installAgentHarness({ cwd: tempDir, mode: 'sync', prune: true })
    expect(pruned.stale).toEqual([])
    expect(pruned.pruned).toBe(false)
    for (const dir of ['.claude/skills/guren-new-app', '.agents/skills/guren-new-app', '.agents/skills/some-vendor-skill']) {
      expect(await readFile(join(tempDir, dir, 'SKILL.md'), 'utf8')).toBe('external skill\n')
      expect(await readFile(join(tempDir, dir, 'references/notes.md'), 'utf8')).toBe('nested\n')
    }
  })

  it('sync still claims a stray file inside a canonical skill directory', async () => {
    // the claim is per named child, recursively — a leftover file inside
    // dev-workflow/ that the current plan does not write is still stale
    await installAgentHarness({ cwd: tempDir, mode: 'init' })
    await writeFile(join(tempDir, '.claude/skills/dev-workflow/OLD.md'), 'leftover\n', 'utf8')
    // one level down as well: a claim that only read the child's top level
    // would report the first file and walk past this one
    await mkdir(join(tempDir, '.claude/skills/dev-workflow/references'), { recursive: true })
    await writeFile(join(tempDir, '.claude/skills/dev-workflow/references/OLD.md'), 'leftover\n', 'utf8')

    const result = await installAgentHarness({ cwd: tempDir, mode: 'sync', prune: true })

    expect(result.stale).toEqual([
      '.claude/skills/dev-workflow/OLD.md',
      '.claude/skills/dev-workflow/references/OLD.md',
    ])
    await expect(access(join(tempDir, '.claude/skills/dev-workflow/OLD.md'))).rejects.toThrow()
    await expect(
      access(join(tempDir, '.claude/skills/dev-workflow/references/OLD.md')),
    ).rejects.toThrow()
    await access(join(tempDir, '.claude/skills/dev-workflow/SKILL.md'))
  })

  it('sync --prune does not delete through a symlinked skill directory even under a claimed name', async () => {
    // same guard as the symlinked-root case: readdir and rm would follow it,
    // and a claim is only safe over files that live inside the app. (The
    // write loop still refreshes SKILL.md through the link — that is the
    // pre-existing managed-file contract, not the claim under test here.)
    await installAgentHarness({ cwd: tempDir, mode: 'init' })
    const outside = join(tempDir, '..', `${basename(tempDir)}-outside`)
    await mkdir(outside, { recursive: true })
    await writeFile(join(outside, 'STRAY.md'), 'not ours to delete\n', 'utf8')
    await rm(join(tempDir, '.claude/skills/dev-workflow'), { recursive: true, force: true })
    await symlink(outside, join(tempDir, '.claude/skills/dev-workflow'), 'dir')

    const result = await installAgentHarness({ cwd: tempDir, mode: 'sync', prune: true })

    // STRAY.md is not planned; through a real directory it would be stale.
    // Through a symlink the child is not entered at all.
    expect(result.stale).toEqual([])
    expect(await readFile(join(outside, 'STRAY.md'), 'utf8')).toBe('not ours to delete\n')
    await rm(outside, { recursive: true, force: true })
  })

  it('sync --prune does not delete through a symlinked skills root above a claimed name', async () => {
    // the children claim walks `.claude/skills/<name>`, so an lstat of that
    // path alone says nothing about `.claude/skills` itself: through a
    // symlinked root the external target reports as an ordinary directory
    await installAgentHarness({ cwd: tempDir, mode: 'init' })
    const outside = join(tempDir, '..', `${basename(tempDir)}-skills`)
    await rename(join(tempDir, '.claude/skills'), outside)
    await symlink(outside, join(tempDir, '.claude/skills'), 'dir')
    await writeFile(join(outside, 'dev-workflow/STRAY.md'), 'not ours to delete\n', 'utf8')

    const result = await installAgentHarness({ cwd: tempDir, mode: 'sync', prune: true })

    expect(result.stale).toEqual([])
    expect(await readFile(join(outside, 'dev-workflow/STRAY.md'), 'utf8')).toBe('not ours to delete\n')
    await rm(outside, { recursive: true, force: true })
  })

  it('sync --prune leaves user files outside the managed name patterns alone', async () => {
    await installAgentHarness({ cwd: tempDir, mode: 'init', targets: ['cursor', 'copilot'] })
    await writeFile(join(tempDir, '.cursor/rules/my-style.mdc'), 'user rule\n', 'utf8')
    await writeFile(join(tempDir, '.github/instructions/team.instructions.md'), 'user instructions\n', 'utf8')

    const result = await installAgentHarness({ cwd: tempDir, mode: 'sync', prune: true })

    expect(result.stale).toEqual([])
    expect(await readFile(join(tempDir, '.cursor/rules/my-style.mdc'), 'utf8')).toBe('user rule\n')
    expect(await readFile(join(tempDir, '.github/instructions/team.instructions.md'), 'utf8')).toBe(
      'user instructions\n',
    )
  })

  it('sync reports a user file in the managed rules root but keeps it by default', async () => {
    await installAgentHarness({ cwd: tempDir, mode: 'init' })
    await writeFile(join(tempDir, '.claude/rules/team-conventions.md'), 'user rule\n', 'utf8')

    const result = await installAgentHarness({ cwd: tempDir, mode: 'sync' })

    expect(result.stale).toEqual(['.claude/rules/team-conventions.md'])
    expect(result.pruned).toBe(false)
    expect(await readFile(join(tempDir, '.claude/rules/team-conventions.md'), 'utf8')).toBe('user rule\n')
  })

  it('sync --prune deletes a colliding user file — why deletion is opt-in', async () => {
    await installAgentHarness({ cwd: tempDir, mode: 'init' })
    await writeFile(join(tempDir, '.claude/rules/team-conventions.md'), 'user rule\n', 'utf8')

    const result = await installAgentHarness({ cwd: tempDir, mode: 'sync', prune: true })

    expect(result.stale).toEqual(['.claude/rules/team-conventions.md'])
    await expect(access(join(tempDir, '.claude/rules/team-conventions.md'))).rejects.toThrow()
  })

  it('sync --prune does not delete through a symlinked .claude, above every namespace in it', async () => {
    // the dotfiles pattern: .claude itself is a link into a shared checkout,
    // and every namespace under it — the rules tree as much as the skills
    // children — is then outside the app. The write loop still refreshes
    // managed files through the link; only the claim to delete stops here.
    await installAgentHarness({ cwd: tempDir, mode: 'init' })
    const outside = join(tempDir, '..', `${basename(tempDir)}-dotfiles`)
    await rename(join(tempDir, '.claude'), outside)
    await symlink(outside, join(tempDir, '.claude'), 'dir')
    await writeFile(join(outside, 'rules/legacy.md'), 'not ours to delete\n', 'utf8')

    const result = await installAgentHarness({ cwd: tempDir, mode: 'sync', prune: true })

    expect(result.stale).toEqual([])
    expect(await readFile(join(outside, 'rules/legacy.md'), 'utf8')).toBe('not ours to delete\n')
    await rm(outside, { recursive: true, force: true })
  })

  it('sync --prune never touches .claude/agents or .claude/hooks', async () => {
    await installAgentHarness({ cwd: tempDir, mode: 'init' })
    await writeFile(join(tempDir, '.claude/agents/my-agent.md'), 'user agent\n', 'utf8')
    await writeFile(join(tempDir, '.claude/hooks/retired-hook.ts'), 'old hook\n', 'utf8')

    const result = await installAgentHarness({ cwd: tempDir, mode: 'sync', prune: true })

    expect(result.stale).toEqual([])
    expect(await readFile(join(tempDir, '.claude/agents/my-agent.md'), 'utf8')).toBe('user agent\n')
    expect(await readFile(join(tempDir, '.claude/hooks/retired-hook.ts'), 'utf8')).toBe('old hook\n')
  })

  it('sync --prune leaves unrelated empty directories in a shared namespace alone', async () => {
    await installAgentHarness({ cwd: tempDir, mode: 'init', targets: ['cursor'] })
    await mkdir(join(tempDir, '.cursor/rules/drafts'), { recursive: true })
    await writeFile(join(tempDir, '.cursor/rules/guren-retired.mdc'), 'stale\n', 'utf8')

    const result = await installAgentHarness({ cwd: tempDir, mode: 'sync', prune: true })

    expect(result.stale).toEqual(['.cursor/rules/guren-retired.mdc'])
    // the sweep follows the deleted files upward; it never removes empty
    // directories the pruning did not create
    await access(join(tempDir, '.cursor/rules/drafts'))
  })

  it('sync never claims through a symlinked managed root', async () => {
    await installAgentHarness({ cwd: tempDir, mode: 'init' })
    // an external rules directory linked into the app: scanning (and prune)
    // must not reach through the link
    await rename(join(tempDir, '.claude/rules'), join(tempDir, 'shared-rules'))
    await symlink(join(tempDir, 'shared-rules'), join(tempDir, '.claude/rules'))
    await writeFile(join(tempDir, 'shared-rules/legacy.md'), 'external\n', 'utf8')

    const result = await installAgentHarness({ cwd: tempDir, mode: 'sync', prune: true })

    expect(result.stale).toEqual([])
    expect(await readFile(join(tempDir, 'shared-rules/legacy.md'), 'utf8')).toBe('external\n')
  })

  it('sync --prune settles a differently-cased entry by identity, not by name', async () => {
    await installAgentHarness({ cwd: tempDir, mode: 'init' })
    const caseInsensitive = await filesystemIsCaseInsensitive(tempDir)
    // what a case-only rename of a managed rule leaves behind: one directory
    // entry on a case-insensitive filesystem, two distinct files on a
    // case-sensitive one, so the two branches assert opposite outcomes
    await rename(
      join(tempDir, '.claude/rules/orm-models.md'),
      join(tempDir, '.claude/rules/ORM-MODELS.md'),
    )

    const result = await installAgentHarness({ cwd: tempDir, mode: 'sync', prune: true })

    // either way the planned path holds the current template
    expect(await readFile(join(tempDir, '.claude/rules/orm-models.md'), 'utf8')).toContain('defineModel')
    if (caseInsensitive) {
      // the entry the write loop just refreshed — pruning it would delete the plan's own output
      expect(result.stale).not.toContain('.claude/rules/ORM-MODELS.md')
    } else {
      expect(result.stale).toContain('.claude/rules/ORM-MODELS.md')
      await expect(access(join(tempDir, '.claude/rules/ORM-MODELS.md'))).rejects.toThrow()
    }
  })

  it('sync --prune scans only the namespaces of the components being synced', async () => {
    await installAgentHarness({ cwd: tempDir, mode: 'init' })
    // an .agents tree with no managed evidence is not a detected component,
    // so its namespace is out of scope for this sync
    await mkdir(join(tempDir, '.agents/rules'), { recursive: true })
    await writeFile(join(tempDir, '.agents/rules/leftover.md'), 'x\n', 'utf8')

    const result = await installAgentHarness({ cwd: tempDir, mode: 'sync', prune: true })

    expect(result.stale).toEqual([])
    expect(result.pruned).toBe(false)
    await access(join(tempDir, '.agents/rules/leftover.md'))
  })

  it('a fresh full install syncs with nothing stale', async () => {
    await installAgentHarness({ cwd: tempDir, mode: 'init', targets: [...AGENT_TARGETS] })

    const result = await installAgentHarness({ cwd: tempDir, mode: 'sync' })

    expect(result.stale).toEqual([])
    expect(result.pruned).toBe(false)
  })

  it('init never reports or deletes stale candidates', async () => {
    await mkdir(join(tempDir, '.claude/rules'), { recursive: true })
    await writeFile(join(tempDir, '.claude/rules/extra.md'), 'user rule\n', 'utf8')

    const result = await installAgentHarness({ cwd: tempDir, mode: 'init', prune: true })

    expect(result.stale).toEqual([])
    expect(result.pruned).toBe(false)
    expect(await readFile(join(tempDir, '.claude/rules/extra.md'), 'utf8')).toBe('user rule\n')
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
