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
 * `AGENTS.md` + `.agents/` family natively. On top of that, cursor and
 * copilot get the canonical rules re-rendered into their native path-scoped
 * formats (`.cursor/rules/*.mdc`, `.github/instructions/*.instructions.md`),
 * and each tool gets its own user-owned extras (MCP client config; Codex
 * also a command approval policy).
 */

export const AGENT_TARGETS = ['claude', 'codex', 'cursor', 'copilot', 'opencode'] as const

export type AgentTarget = (typeof AGENT_TARGETS)[number]

/**
 * The independently installable pieces of the harness. `agent:sync` detects
 * these on disk (not targets): codex and opencode produce identical managed
 * files, and their tool-specific extras (MCP config, command approval
 * policy) are user-owned, so sync never needs to tell them apart.
 */
export type HarnessComponent = 'claude' | 'agents' | 'cursor' | 'copilot' | 'codex' | 'opencode'

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
  if (targets.includes('cursor')) {
    components.push('cursor')
  }
  if (targets.includes('copilot')) {
    components.push('copilot')
  }
  if (targets.includes('codex')) {
    components.push('codex')
  }
  if (targets.includes('opencode')) {
    components.push('opencode')
  }
  return components
}

const RULES_DIR_TOKEN = '__RULES_DIR__'

interface RuleDoc {
  description: string
  globs: string[]
  /** Everything after the closing `---`, leading newline included. */
  body: string
}

/**
 * Parse a canonical rule file's frontmatter (`description` + `globs` list).
 * The format is framework-authored, so this is strict on purpose: a rule the
 * parser cannot read must fail the install (and the test suite) loudly, not
 * ship to Cursor/Copilot with an empty scope.
 */
function parseRuleDoc(name: string, content: string): RuleDoc {
  const match = content.match(/^---\n([\s\S]*?)\n---(\n[\s\S]*)$/u)
  if (!match) {
    throw new Error(`Agent harness rule ${name} is missing its frontmatter block`)
  }
  const [, header, body] = match
  let description = ''
  const globs: string[] = []
  let inGlobs = false
  for (const line of header!.split('\n')) {
    if (line.startsWith('description:')) {
      description = line.slice('description:'.length).trim()
      inGlobs = false
    } else if (line.trim() === 'globs:') {
      inGlobs = true
    } else if (inGlobs && line.trim().startsWith('- ')) {
      globs.push(line.trim().slice(2).trim().replace(/^"(.*)"$/u, '$1'))
    } else if (line.trim() !== '') {
      inGlobs = false
    }
  }
  if (!description || globs.length === 0) {
    throw new Error(`Agent harness rule ${name} needs a description and at least one glob`)
  }
  return { description, globs, body: body! }
}

/** Cursor rule: `.mdc` frontmatter with a comma-joined glob string. */
function renderCursorRule(doc: RuleDoc): string {
  return `---\ndescription: ${doc.description}\nglobs: ${doc.globs.join(',')}\nalwaysApply: false\n---${doc.body}`
}

/** Copilot instructions: `applyTo` carries the comma-joined glob string. */
function renderCopilotRule(doc: RuleDoc): string {
  return `---\ndescription: ${doc.description}\napplyTo: "${doc.globs.join(',')}"\n---${doc.body}`
}

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
    // Claude Code does not read AGENTS.md, so it always gets the full
    // CLAUDE.md — even next to an AGENTS.md for other agents. The two
    // describe the same project; each tool reads only its own entry file.
    add({ path: 'CLAUDE.md', content: get('targets/claude/CLAUDE.md'), managed: false })
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

  // Cursor and Copilot load path-scoped rules natively; re-render the
  // canonical rules into their formats. Generated files in these shared
  // directories carry a `guren-` prefix so framework ownership stays
  // unambiguous next to user-authored rules.
  if (components.includes('cursor')) {
    for (const [rel, content] of under('core/rules/')) {
      const doc = parseRuleDoc(rel, content)
      add({
        path: `.cursor/rules/guren-${rel.replace(/\.md$/u, '')}.mdc`,
        content: renderCursorRule(doc),
        managed: true,
      })
    }
    add({
      path: '.cursor/mcp.json',
      content: get('targets/cursor/mcp.json'),
      managed: false,
      mergeHint: true,
    })
  }
  if (components.includes('copilot')) {
    for (const [rel, content] of under('core/rules/')) {
      const doc = parseRuleDoc(rel, content)
      add({
        path: `.github/instructions/guren-${rel.replace(/\.md$/u, '')}.instructions.md`,
        content: renderCopilotRule(doc),
        managed: true,
      })
    }
    add({
      path: '.vscode/mcp.json',
      content: get('targets/copilot/mcp.json'),
      managed: false,
      mergeHint: true,
    })
  }

  if (components.includes('codex')) {
    add({
      path: '.codex/config.toml',
      content: get('targets/codex/config.toml'),
      managed: false,
      mergeHint: true,
    })
    // Codex's analogue of the .claude/settings.json permission allowlist:
    // Starlark approval rules for shell commands, not instruction rules.
    // User-owned like settings.json — sync never widens a policy file.
    add({
      path: '.codex/rules/guren.rules',
      content: get('targets/codex/rules/guren.rules'),
      managed: false,
    })
  }
  if (components.includes('opencode')) {
    add({
      path: 'opencode.json',
      content: get('targets/opencode/opencode.json'),
      managed: false,
      mergeHint: true,
    })
  }

  return [...planned.values()].sort((a, b) => a.path.localeCompare(b.path))
}
