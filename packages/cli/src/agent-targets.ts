import { parseDocFrontmatter } from './docs-frontmatter'

/**
 * The one rule for which files each agent target owns and how the canonical
 * harness content renders into them (RFC 0008).
 *
 * The template ships agent-neutral canonical content (`core/`: the entry
 * document's shared intro/body, rules, skills) plus per-target statics
 * (`targets/`). This module plans the app-relative files a target selection
 * produces — paths, fully rendered content, and whether `agent:sync` owns
 * the file. `agent-harness.ts` does the I/O and derives sync detection from
 * the same plans; a scaffolder, detector, or sync path that invented its own
 * mapping is how the same rule file ends up in two locations with drifting
 * content.
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
 * Components whose managed files identify them on disk, letting `agent:sync`
 * re-plan them. codex/opencode are not here: their managed output is the
 * shared `agents` family, and their only distinct files are user-owned
 * extras sync must never re-plan (it cannot tell the two tools apart, and it
 * never widens a user's config).
 */
export type DetectableComponent = 'claude' | 'agents' | 'cursor' | 'copilot'

/** The independently installable pieces of the harness. */
export type HarnessComponent = DetectableComponent | 'codex' | 'opencode'

export const DETECTABLE_COMPONENTS: DetectableComponent[] = [
  'claude',
  'agents',
  'cursor',
  'copilot',
]

const COMPONENT_ORDER: HarnessComponent[] = [
  'claude',
  'agents',
  'cursor',
  'copilot',
  'codex',
  'opencode',
]

/**
 * The substring that marks an MCP client config as already carrying the
 * Guren endpoint. One spelling for planner and installer; the endpoint URL
 * itself lives in the `targets/*` MCP templates.
 */
export const MCP_ENDPOINT_MARKER = '_guren/mcp'

export interface PlannedFile {
  /** App-relative POSIX path, e.g. `.agents/rules/testing.md`. */
  path: string
  /** Fully rendered content — no template tokens survive planning. */
  content: string
  /** true → `agent:sync` overwrites; false → written once, only `init --force` replaces. */
  managed: boolean
  /**
   * Set on MCP client configs: when the file already exists without this
   * marker, `agent:init` reports the content as a snippet to merge by hand
   * instead of touching a config that may carry unrelated settings.
   */
  mergeMarker?: string
}

/** Template-relative POSIX path → raw content. */
export type TemplateFiles = Map<string, string>

/**
 * Template paths `planComponents` consumes by name. Everything else must sit
 * under `BULK_TEMPLATE_PREFIXES`; the completeness test in
 * `tests/agent-targets.test.ts` fails on any template file reachable by
 * neither route, so a new file cannot be silently left uninstalled.
 */
export const NAMED_TEMPLATE_PATHS = [
  'core/entry-intro.md',
  'core/entry-body.md',
  'targets/claude/workflow.md',
  'targets/claude/mcp.json',
  'targets/claude/settings.json',
  'targets/agents/workflow.md',
  'targets/codex/config.toml',
  'targets/codex/rules/guren.rules',
  'targets/cursor/mcp.json',
  'targets/copilot/mcp.json',
  'targets/opencode/opencode.json',
] as const

/** Template directories copied wholesale into a planned tree. */
export const BULK_TEMPLATE_PREFIXES = [
  'core/rules/',
  'core/skills/',
  'targets/claude/agents/',
  'targets/claude/hooks/',
] as const

/**
 * Parse a `--target` value: comma-separated target names, or `all`.
 * Every entry is validated before `all` expands, so a typo never silently
 * installs anything.
 */
export function parseTargetList(raw: string): AgentTarget[] {
  const parts = raw
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean)

  const targets: AgentTarget[] = []
  let all = false
  for (const part of parts) {
    if (part === 'all') {
      all = true
      continue
    }
    if (!(AGENT_TARGETS as readonly string[]).includes(part)) {
      throw new Error(
        `Unknown agent target "${part}". Valid targets: ${AGENT_TARGETS.join(', ')}, all.`,
      )
    }
    if (!targets.includes(part as AgentTarget)) {
      targets.push(part as AgentTarget)
    }
  }
  if (all) {
    return [...AGENT_TARGETS]
  }
  if (targets.length === 0) {
    throw new Error(`No agent targets given. Valid targets: ${AGENT_TARGETS.join(', ')}, all.`)
  }
  return targets
}

export function componentsForTargets(targets: AgentTarget[]): HarnessComponent[] {
  // every target name is also its component name; the shared agents family
  // joins whenever any non-Claude tool is selected
  const active = new Set<HarnessComponent>(targets)
  if (targets.some((target) => target !== 'claude')) {
    active.add('agents')
  }
  return COMPONENT_ORDER.filter((component) => active.has(component))
}

const RULES_DIR_TOKEN = '__RULES_DIR__'
const APP_TITLE_TOKEN = '__APP_TITLE__'
const TOKEN_RE = /__[A-Z][A-Z_]*__/u

interface RuleDoc {
  description: string
  globs: string[]
  /** Everything after the closing `---`. */
  body: string
}

/**
 * Read a canonical rule file's frontmatter (`description` + `globs` list)
 * via the shared docs-frontmatter parser. The format is framework-authored,
 * so validation is strict on purpose: a rule this cannot read must fail the
 * install (and the test suite) loudly, not ship to Cursor/Copilot with an
 * empty scope.
 */
function parseRuleDoc(name: string, content: string): RuleDoc {
  const parsed = parseDocFrontmatter(content)
  const description = typeof parsed?.data.description === 'string' ? parsed.data.description : ''
  const globs = Array.isArray(parsed?.data.globs)
    ? parsed.data.globs.filter((glob): glob is string => typeof glob === 'string')
    : []
  if (!parsed || !description || globs.length === 0) {
    throw new Error(`Agent harness rule ${name} needs a description and at least one glob`)
  }
  return { description, globs, body: parsed.body }
}

/** Cursor rule: `.mdc` frontmatter with a comma-joined glob string. */
function renderCursorRule(doc: RuleDoc): string {
  return `---\ndescription: ${doc.description}\nglobs: ${doc.globs.join(',')}\nalwaysApply: false\n---\n${doc.body}`
}

/** Copilot instructions: `applyTo` carries the comma-joined glob string. */
function renderCopilotRule(doc: RuleDoc): string {
  return `---\ndescription: ${doc.description}\napplyTo: "${doc.globs.join(',')}"\n---\n${doc.body}`
}

export function planComponents(
  components: HarnessComponent[],
  templates: TemplateFiles,
  appTitle: string,
): PlannedFile[] {
  const planned = new Map<string, PlannedFile>()
  const add = (file: PlannedFile): void => {
    const leftover = TOKEN_RE.exec(file.content)
    if (leftover) {
      throw new Error(`Agent harness left ${leftover[0]} unrendered in ${file.path}`)
    }
    const existing = planned.get(file.path)
    if (existing) {
      if (existing.content !== file.content) {
        throw new Error(`Agent harness planned conflicting content for ${file.path}`)
      }
      return
    }
    planned.set(file.path, file)
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

  const render = (content: string, rulesDir?: string): string => {
    const withTitle = content.replaceAll(APP_TITLE_TOKEN, appTitle)
    return rulesDir === undefined ? withTitle : withTitle.replaceAll(RULES_DIR_TOKEN, rulesDir)
  }

  /** Entry document: shared intro + per-target workflow + shared body. */
  const entryDoc = (workflowPath: string, rulesDir: string): string =>
    render(
      `${get('core/entry-intro.md')}\n${get(workflowPath)}\n${get('core/entry-body.md')}`,
      rulesDir,
    )

  /** The canonical rules + skills trees, rendered for one root directory. */
  const addCanonical = (root: '.claude' | '.agents'): void => {
    for (const [rel, content] of under('core/rules/')) {
      add({ path: `${root}/rules/${rel}`, content: render(content), managed: true })
    }
    for (const [rel, content] of under('core/skills/')) {
      add({ path: `${root}/skills/${rel}`, content: render(content, `${root}/rules`), managed: true })
    }
  }

  if (components.includes('claude')) {
    // Claude Code does not read AGENTS.md, so it always gets the full
    // CLAUDE.md — even next to an AGENTS.md for other agents. Same intro and
    // body; only the workflow section differs (hooks vs. manual loop).
    add({
      path: 'CLAUDE.md',
      content: entryDoc('targets/claude/workflow.md', '.claude/rules'),
      managed: false,
    })
    add({
      path: '.mcp.json',
      content: get('targets/claude/mcp.json'),
      managed: false,
      mergeMarker: MCP_ENDPOINT_MARKER,
    })
    add({
      path: '.claude/settings.json',
      content: get('targets/claude/settings.json'),
      managed: false,
    })
    for (const [rel, content] of under('targets/claude/agents/')) {
      add({ path: `.claude/agents/${rel}`, content: render(content), managed: true })
    }
    for (const [rel, content] of under('targets/claude/hooks/')) {
      add({ path: `.claude/hooks/${rel}`, content: render(content), managed: true })
    }
    addCanonical('.claude')
  }

  if (components.includes('agents')) {
    add({
      path: 'AGENTS.md',
      content: entryDoc('targets/agents/workflow.md', '.agents/rules'),
      managed: false,
    })
    addCanonical('.agents')
  }

  // Cursor and Copilot load path-scoped rules natively; re-render the
  // canonical rules into their formats. Generated files in these shared
  // directories carry a `guren-` prefix so framework ownership stays
  // unambiguous next to user-authored rules.
  let ruleDocsCache: Array<[stem: string, doc: RuleDoc]> | undefined
  const nativeRuleDocs = (): Array<[stem: string, doc: RuleDoc]> =>
    (ruleDocsCache ??= under('core/rules/').map(([rel, content]) => [
      rel.replace(/\.md$/u, ''),
      parseRuleDoc(rel, content),
    ]))

  if (components.includes('cursor')) {
    for (const [stem, doc] of nativeRuleDocs()) {
      add({ path: `.cursor/rules/guren-${stem}.mdc`, content: renderCursorRule(doc), managed: true })
    }
    add({
      path: '.cursor/mcp.json',
      content: get('targets/cursor/mcp.json'),
      managed: false,
      mergeMarker: MCP_ENDPOINT_MARKER,
    })
  }
  if (components.includes('copilot')) {
    for (const [stem, doc] of nativeRuleDocs()) {
      add({
        path: `.github/instructions/guren-${stem}.instructions.md`,
        content: renderCopilotRule(doc),
        managed: true,
      })
    }
    add({
      path: '.vscode/mcp.json',
      content: get('targets/copilot/mcp.json'),
      managed: false,
      mergeMarker: MCP_ENDPOINT_MARKER,
    })
  }

  if (components.includes('codex')) {
    add({
      path: '.codex/config.toml',
      content: get('targets/codex/config.toml'),
      managed: false,
      mergeMarker: MCP_ENDPOINT_MARKER,
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
      mergeMarker: MCP_ENDPOINT_MARKER,
    })
  }

  return [...planned.values()].sort((a, b) => a.path.localeCompare(b.path))
}
