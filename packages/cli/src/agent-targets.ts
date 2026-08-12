/**
 * The one rule for which files each agent target owns and how the canonical
 * harness content renders into them (RFC 0008).
 *
 * The template ships agent-neutral canonical content (`core/`: AGENTS.md,
 * rules, skills) plus per-target statics (`targets/`). This module plans the
 * app-relative files a target selection produces — paths, rendered content,
 * and whether `agent:sync` owns the file. `agent-harness.ts` does the I/O;
 * a scaffolder or sync path that invented its own mapping is how the same
 * rule file ends up in two locations with drifting content.
 *
 * Targets collapse onto shared components: every non-Claude agent reads the
 * `AGENTS.md` + `.agents/` family natively, so codex/cursor/copilot/opencode
 * differ only in which user-owned MCP client config they add.
 */

export const AGENT_TARGETS = ['claude', 'codex', 'cursor', 'copilot', 'opencode'] as const

export type AgentTarget = (typeof AGENT_TARGETS)[number]

/**
 * The independently installable pieces of the harness. `agent:sync` detects
 * these on disk (not targets): codex and opencode produce identical managed
 * files, and their MCP configs are user-owned, so sync never needs to tell
 * them apart.
 */
export type HarnessComponent = 'claude' | 'agents' | 'codex-mcp' | 'opencode-mcp'

export interface PlannedFile {
  /** App-relative POSIX path, e.g. `.agents/rules/testing.md`. */
  path: string
  content: string
  /** true → `agent:sync` overwrites; false → written once, only `init --force` replaces. */
  managed: boolean
  /**
   * User-owned MCP client config: when the file already exists without the
   * Guren endpoint, the installer reports the content as a snippet to merge
   * by hand instead of touching a config that may carry unrelated settings.
   */
  mergeHint?: boolean
}

/** Template-relative POSIX path → raw content. */
export type TemplateFiles = Map<string, string>

/**
 * Parse a `--target` value: comma-separated target names, or `all`.
 * Throws on unknown names so a typo never silently installs the default.
 */
export function parseTargetList(raw: string): AgentTarget[] {
  const parts = raw
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean)

  if (parts.includes('all')) {
    return [...AGENT_TARGETS]
  }

  const targets: AgentTarget[] = []
  for (const part of parts) {
    if (!(AGENT_TARGETS as readonly string[]).includes(part)) {
      throw new Error(
        `Unknown agent target "${part}". Valid targets: ${AGENT_TARGETS.join(', ')}, all.`,
      )
    }
    if (!targets.includes(part as AgentTarget)) {
      targets.push(part as AgentTarget)
    }
  }
  if (targets.length === 0) {
    throw new Error(`No agent targets given. Valid targets: ${AGENT_TARGETS.join(', ')}, all.`)
  }
  return targets
}

export function componentsForTargets(targets: AgentTarget[]): HarnessComponent[] {
  const components: HarnessComponent[] = []
  if (targets.includes('claude')) {
    components.push('claude')
  }
  if (targets.some((target) => target !== 'claude')) {
    components.push('agents')
  }
  if (targets.includes('codex')) {
    components.push('codex-mcp')
  }
  if (targets.includes('opencode')) {
    components.push('opencode-mcp')
  }
  return components
}

const RULES_DIR_TOKEN = '__RULES_DIR__'

export function planComponents(
  components: HarnessComponent[],
  templates: TemplateFiles,
): PlannedFile[] {
  const planned = new Map<string, PlannedFile>()
  const add = (file: PlannedFile): void => {
    if (!planned.has(file.path)) {
      planned.set(file.path, file)
    }
  }
  const get = (templatePath: string): string => {
    const content = templates.get(templatePath)
    if (content === undefined) {
      throw new Error(`Agent harness template is missing ${templatePath}`)
    }
    return content
  }
  const under = (prefix: string): Array<[rel: string, content: string]> =>
    [...templates]
      .filter(([path]) => path.startsWith(prefix))
      .map(([path, content]) => [path.slice(prefix.length), content])

  const hasAgents = components.includes('agents')

  if (components.includes('claude')) {
    // Claude Code does not read AGENTS.md; when the agents family is also
    // installed, CLAUDE.md becomes a thin @AGENTS.md import instead of a
    // second full copy of the guide.
    add({
      path: 'CLAUDE.md',
      content: get(hasAgents ? 'targets/claude/CLAUDE.multi.md' : 'targets/claude/CLAUDE.md'),
      managed: false,
    })
    add({ path: '.mcp.json', content: get('targets/claude/mcp.json'), managed: false })
    add({
      path: '.claude/settings.json',
      content: get('targets/claude/settings.json'),
      managed: false,
    })
    for (const [rel, content] of under('targets/claude/agents/')) {
      add({ path: `.claude/agents/${rel}`, content, managed: true })
    }
    for (const [rel, content] of under('targets/claude/hooks/')) {
      add({ path: `.claude/hooks/${rel}`, content, managed: true })
    }
    for (const [rel, content] of under('core/rules/')) {
      add({ path: `.claude/rules/${rel}`, content, managed: true })
    }
    for (const [rel, content] of under('core/skills/')) {
      add({
        path: `.claude/skills/${rel}`,
        content: content.replaceAll(RULES_DIR_TOKEN, '.claude/rules'),
        managed: true,
      })
    }
  }

  if (hasAgents) {
    add({ path: 'AGENTS.md', content: get('core/AGENTS.md'), managed: false })
    for (const [rel, content] of under('core/rules/')) {
      add({ path: `.agents/rules/${rel}`, content, managed: true })
    }
    for (const [rel, content] of under('core/skills/')) {
      add({
        path: `.agents/skills/${rel}`,
        content: content.replaceAll(RULES_DIR_TOKEN, '.agents/rules'),
        managed: true,
      })
    }
  }

  if (components.includes('codex-mcp')) {
    add({
      path: '.codex/config.toml',
      content: get('targets/codex/config.toml'),
      managed: false,
      mergeHint: true,
    })
  }
  if (components.includes('opencode-mcp')) {
    add({
      path: 'opencode.json',
      content: get('targets/opencode/opencode.json'),
      managed: false,
      mergeHint: true,
    })
  }

  return [...planned.values()].sort((a, b) => a.path.localeCompare(b.path))
}
