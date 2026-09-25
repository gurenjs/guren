import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installAgentHarness, loadAgentTemplates } from '../src/agent-harness'
import { AGENT_TARGETS, LEGACY_HOOK_COMMANDS, componentsForTargets, planComponents } from '../src/agent-targets'

// Claude Code runs a hook command in the session cwd, which follows the agent's `cd`,
// so a command naming `.claude/…` or `.codex/…` relative to it stops resolving there.
// Out of scope: Cursor runs project hooks from the project root (its docs recommend
// `.cursor/hooks/…`), and Copilot and OpenCode ship no hooks.
const HOOK_CONFIGS = ['.claude/settings.json', '.codex/hooks.json', '.cursor/hooks.json']
const RELATIVE_HARNESS_PATH = /(?:^|[\s"'])(?:\.\/)?\.(?:claude|codex)\//u

function commandsIn(config: unknown): string[] {
  if (Array.isArray(config)) return config.flatMap(commandsIn)
  if (config === null || typeof config !== 'object') return []
  return Object.entries(config).flatMap(([key, value]) =>
    key === 'command' && typeof value === 'string' ? [value] : commandsIn(value),
  )
}

async function shippedCommands(): Promise<Map<string, string[]>> {
  const plan = planComponents(componentsForTargets([...AGENT_TARGETS]), await loadAgentTemplates(), 'App')
  const commands = new Map<string, string[]>()
  for (const file of plan) {
    if (HOOK_CONFIGS.includes(file.path)) {
      commands.set(file.path, commandsIn((JSON.parse(file.content) as { hooks?: unknown }).hooks))
    }
  }
  return commands
}

describe('shipped hook commands', () => {
  test('every hook config is planned and carries commands', async () => {
    const commands = await shippedCommands()
    expect([...commands.keys()].sort()).toEqual([...HOOK_CONFIGS].sort())
    for (const list of commands.values()) expect(list.length).toBeGreaterThan(0)
  })

  test('no command reaches a harness script relative to the cwd', async () => {
    for (const [path, list] of await shippedCommands()) {
      for (const command of list) {
        expect({ path, command, relative: RELATIVE_HARNESS_PATH.test(command) }).toEqual({ path, command, relative: false })
      }
    }
  })

  test('every Claude Code command is anchored to CLAUDE_PROJECT_DIR', async () => {
    const commands = (await shippedCommands()).get('.claude/settings.json') ?? []
    for (const command of commands) expect(command).toContain('"${CLAUDE_PROJECT_DIR}')
  })

  test('each legacy command maps to a command the template ships', async () => {
    const commands = await shippedCommands()
    for (const entry of LEGACY_HOOK_COMMANDS) {
      expect(commands.get(entry.path)).toContain(entry.to)
      expect(commands.get(entry.path)).not.toContain(entry.from)
    }
  })
})

describe('legacy hook commands in an existing .claude/settings.json', () => {
  let dir: string

  // What `agent:init` wrote before the commands were anchored.
  const legacySettings = {
    permissions: { allow: ['Bash(bunx guren:*)'] },
    hooks: {
      SessionStart: [{ hooks: [{ type: 'command', command: 'bunx guren context 2>/dev/null || true' }] }],
      PostToolUse: [{ matcher: 'Edit|Write|MultiEdit', hooks: [{ type: 'command', command: 'bun .claude/hooks/check-after-edit.ts' }] }],
      Stop: [{ hooks: [{ type: 'command', command: 'bun .claude/hooks/gate-on-stop.ts', timeout: 300 }] }],
    },
  }

  async function writeSettings(settings: unknown): Promise<void> {
    await mkdir(join(dir, '.claude'), { recursive: true })
    await writeFile(join(dir, '.claude/settings.json'), JSON.stringify(settings, null, 2))
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'guren-hook-commands-'))
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'app' }))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  test('sync reports each one with its replacement and leaves the file alone', async () => {
    await writeSettings(legacySettings)
    const before = await readFile(join(dir, '.claude/settings.json'), 'utf8')

    const result = await installAgentHarness({ cwd: dir, mode: 'sync' })

    expect(result.skipped).toContain('.claude/settings.json')
    expect(result.legacyHookCommands).toEqual([...LEGACY_HOOK_COMMANDS])
    expect(await readFile(join(dir, '.claude/settings.json'), 'utf8')).toBe(before)
  })

  test('a dry run and init report them too', async () => {
    await writeSettings(legacySettings)
    expect((await installAgentHarness({ cwd: dir, mode: 'sync', dryRun: true })).legacyHookCommands).toHaveLength(3)
    expect((await installAgentHarness({ cwd: dir, mode: 'init' })).legacyHookCommands).toHaveLength(3)
  })

  test('the replacement, pasted in, clears the report', async () => {
    let text = JSON.stringify(legacySettings, null, 2)
    for (const entry of LEGACY_HOOK_COMMANDS) text = text.replace(JSON.stringify(entry.from), JSON.stringify(entry.to))
    await writeSettings(JSON.parse(text))

    expect((await installAgentHarness({ cwd: dir, mode: 'sync' })).legacyHookCommands).toEqual([])
  })

  test("a command the user wrote, or init --force's rewrite, is never reported", async () => {
    await writeSettings({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'bun .claude/hooks/gate-on-stop.ts --verbose' }] }] } })
    expect((await installAgentHarness({ cwd: dir, mode: 'sync' })).legacyHookCommands).toEqual([])

    await writeSettings(legacySettings)
    expect((await installAgentHarness({ cwd: dir, mode: 'init', force: true })).legacyHookCommands).toEqual([])
  })
})
