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

/** The independently installable pieces of the harness, in install order. */
const COMPONENT_ORDER = ['claude', 'agents', 'cursor', 'copilot', 'codex', 'opencode'] as const

export type HarnessComponent = (typeof COMPONENT_ORDER)[number]

/**
 * Components whose managed files identify them on disk, letting `agent:sync`
 * re-plan them. codex/opencode are not here: their managed output is the
 * shared `agents` family, and their only distinct files are user-owned
 * extras sync must never re-plan (it cannot tell the two tools apart, and it
 * never widens a user's config).
 */
export const DETECTABLE_COMPONENTS = [
  'claude',
  'agents',
  'cursor',
  'copilot',
] as const satisfies readonly HarnessComponent[]

export type DetectableComponent = (typeof DETECTABLE_COMPONENTS)[number]

/**
 * The substring that marks an MCP client config as already carrying the
 * Guren endpoint. One spelling for every planned config; the endpoint URL
 * itself lives in the `targets/*` MCP templates.
 */
const MCP_ENDPOINT_MARKER = '_guren/mcp'

/**
 * A claim over files the planner owns outright: anything matching it that the
 * current plan does not write is a leftover from an earlier harness version —
 * a renamed or removed canonical rule or skill — and `agent:sync` may report
 * it and, with `--prune`, delete it. Three shapes exist: a `tree` claims a
 * whole canonical root recursively; a `pattern` claims only framework-named
 * files at the top of a directory shared with user-authored files; a
 * `children` claims named subdirectories of a root, each recursively, and
 * nothing else beneath that root.
 *
 * The skills roots are `children`, not `tree`, because they are shared with
 * installers the framework does not control: `npx skills add` and the Agent
 * Plugins clients copy third-party skills straight into `.agents/skills/` and
 * `.claude/skills/`, flat and unnamespaced (RFC 0011). A tree claim there
 * turned every one of them into a prune candidate — including the framework's
 * own catalog-distributed skills. The claim therefore names exactly what the
 * framework has ever written: the planned skills plus `RETIRED_CANONICAL_SKILLS`.
 */
export type ManagedNamespace =
  | { kind: 'tree'; dir: string }
  | { kind: 'pattern'; dir: string; prefix: string; suffix: string }
  | { kind: 'children'; dir: string; names: readonly string[] }

type PatternNamespace = Extract<ManagedNamespace, { kind: 'pattern' }>

/**
 * The one spelling of a family root's canonical directories. `planComponents`
 * builds every written path from it and `managedNamespaces` claims the same
 * value, so a renamed root cannot leave the claim pointing at the old
 * location (where prune would then eat the freshly written files).
 */
function canonicalDirs(root: '.claude' | '.agents'): { rules: string; skills: string } {
  return { rules: `${root}/rules`, skills: `${root}/skills` }
}

/**
 * Canonical skill directory names the harness shipped in an earlier version
 * and no longer plans. Prune still owns these: a `children` claim over the
 * current plan alone could never recognize a skill that left the set, and
 * cleaning those up on `agent:sync --prune` is deliberate, tested behavior.
 * Removing a skill from `core/skills/` means adding its old name here. No
 * test can enforce that — the repository has no record of what it used to
 * ship — so it is a review obligation on any PR that deletes a skill
 * directory; the test only pins that a retired name never returns as a
 * shipped one.
 * Same device as the tombstones in `data-types.ts`: a dropped definition
 * whose name must stay claimed.
 */
export const RETIRED_CANONICAL_SKILLS: readonly string[] = []

/**
 * The native-rule namespaces double as the path rule `planComponents` writes
 * with, so the prune pattern and the written names cannot drift apart.
 */
const CURSOR_RULES_NAMESPACE: PatternNamespace = {
  kind: 'pattern',
  dir: '.cursor/rules',
  prefix: 'guren-',
  suffix: '.mdc',
}

const COPILOT_RULES_NAMESPACE: PatternNamespace = {
  kind: 'pattern',
  dir: '.github/instructions',
  prefix: 'guren-',
  suffix: '.instructions.md',
}

function nativeRulePath(namespace: PatternNamespace, stem: string): string {
  return `${namespace.dir}/${namespace.prefix}${stem}${namespace.suffix}`
}

/**
 * The skill directory names a `children` claim over `skillsDir` covers: every
 * immediate child the plan writes into, plus the retired names. Derived from
 * the plan rather than listed, so a renamed or added canonical skill cannot
 * leave the claim behind.
 */
/**
 * A claimed child must be exactly one plain path segment: no separators, no
 * `.`/`..`, not empty. The claim is interpolated into a directory the prune
 * walker will `rm` under, so a name like `..` would claim outside the app.
 * Planned names come from the planner and cannot violate this; the retired
 * list is a constant plus a test hook, and this is the one place both are
 * checked before they reach the walker.
 */
function assertSkillName(name: string): void {
  if (name === '' || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
    throw new Error(`Agent harness skill claim "${name}" is not a single path segment`)
  }
}

function claimedSkillNames(
  skillsDir: string,
  plan: readonly PlannedFile[],
  retired: readonly string[],
): string[] {
  for (const name of retired) {
    assertSkillName(name)
  }
  const names = new Set<string>(retired)
  const prefix = `${skillsDir}/`
  for (const file of plan) {
    if (!file.managed || !file.path.startsWith(prefix)) {
      continue
    }
    const child = file.path.slice(prefix.length).split('/')[0]
    if (child) {
      assertSkillName(child)
      names.add(child)
    }
  }
  return [...names].sort()
}

/**
 * The namespaces the given components own. Deliberately narrower than the
 * managed file set: `.claude/agents/` and `.claude/hooks/` ship managed files
 * too, but those directories are the conventional home for user-authored
 * subagents and hooks, and a name pattern cannot tell the two apart — so
 * stale copies there are left to the user rather than claimed for pruning.
 * The rules/skills roots are claimed wholesale: they are the fan-out set a
 * rename multiplies across every root, and the entry documents present them
 * as the framework's rule catalog.
 */
export function managedNamespaces(
  components: Iterable<HarnessComponent>,
  plan: readonly PlannedFile[],
  retiredSkills: readonly string[] = RETIRED_CANONICAL_SKILLS,
): ManagedNamespace[] {
  const active = new Set<HarnessComponent>(components)
  const namespaces: ManagedNamespace[] = []
  const claimFamily = (root: '.claude' | '.agents'): void => {
    const dirs = canonicalDirs(root)
    namespaces.push(
      { kind: 'tree', dir: dirs.rules },
      {
        kind: 'children',
        dir: dirs.skills,
        names: claimedSkillNames(dirs.skills, plan, retiredSkills),
      },
    )
  }
  if (active.has('claude')) {
    claimFamily('.claude')
  }
  if (active.has('agents')) {
    claimFamily('.agents')
  }
  if (active.has('cursor')) {
    namespaces.push(CURSOR_RULES_NAMESPACE)
  }
  if (active.has('copilot')) {
    namespaces.push(COPILOT_RULES_NAMESPACE)
  }
  return namespaces
}

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
 * Template directories copied wholesale into a planned tree (consumed by
 * iteration, not by name). Everything else must be `get()`-consumed by
 * `planComponents`; the completeness test in `tests/agent-targets.test.ts`
 * records the planner's actual reads over the real templates and fails on
 * any file reachable by neither route, so a new template cannot be silently
 * left uninstalled.
 */
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

/**
 * Order components and restore the install invariant: every non-Claude tool
 * implies the shared agents family. `agent:sync` funnels detected components
 * through this too, so a cursor/copilot install whose `.agents/` tree was
 * deleted gets it recreated instead of refreshing native rules that
 * reference a directory that no longer exists.
 */
export function normalizeComponents(components: Iterable<HarnessComponent>): HarnessComponent[] {
  const active = new Set<HarnessComponent>(components)
  if ([...active].some((component) => component !== 'claude' && component !== 'agents')) {
    active.add('agents')
  }
  return COMPONENT_ORDER.filter((component) => active.has(component))
}

export function componentsForTargets(targets: AgentTarget[]): HarnessComponent[] {
  // every target name is also its component name
  return normalizeComponents(targets)
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

  /**
   * Entry document: shared intro + per-target workflow + shared rule catalog
   * + shared body. The workflow fragment owns its own headings (or continues
   * the intro's last section) and ends with its target's lead-in to the
   * catalog; catalog and body stay target-neutral apart from __RULES_DIR__.
   */
  const entryDoc = (workflowPath: string, rulesDir: string): string =>
    render(
      `${get('core/entry-intro.md')}\n${get(workflowPath)}\n${get('core/rules-catalog.md')}\n${get('core/entry-body.md')}`,
      rulesDir,
    )

  /** Every MCP client config is user-owned and merge-hinted the same way. */
  const addMcpConfig = (path: string, templatePath: string): void =>
    add({
      path,
      content: get(templatePath),
      managed: false,
      mergeMarker: MCP_ENDPOINT_MARKER,
    })

  /** The canonical rules + skills trees, rendered for one root directory. */
  const addCanonical = (root: '.claude' | '.agents'): void => {
    const dirs = canonicalDirs(root)
    for (const [rel, content] of under('core/rules/')) {
      add({ path: `${dirs.rules}/${rel}`, content: render(content), managed: true })
    }
    for (const [rel, content] of under('core/skills/')) {
      add({ path: `${dirs.skills}/${rel}`, content: render(content, dirs.rules), managed: true })
    }
  }

  if (components.includes('claude')) {
    // Claude Code does not read AGENTS.md, so it always gets the full
    // CLAUDE.md — even next to an AGENTS.md for other agents. Same intro and
    // body; only the workflow section differs (hooks vs. manual loop).
    add({
      path: 'CLAUDE.md',
      content: entryDoc('targets/claude/workflow.md', canonicalDirs('.claude').rules),
      managed: false,
    })
    addMcpConfig('.mcp.json', 'targets/claude/mcp.json')
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
      content: entryDoc('targets/agents/workflow.md', canonicalDirs('.agents').rules),
      managed: false,
    })
    addCanonical('.agents')
  }

  // Cursor and Copilot load path-scoped rules natively; re-render the
  // canonical rules into their formats. Generated files in these shared
  // directories carry a `guren-` prefix so framework ownership stays
  // unambiguous next to user-authored rules.
  const nativeRuleDocs: Array<[stem: string, doc: RuleDoc]> =
    components.includes('cursor') || components.includes('copilot')
      ? under('core/rules/').map(([rel, content]) => [
          rel.replace(/\.md$/u, ''),
          parseRuleDoc(rel, content),
        ])
      : []

  if (components.includes('cursor')) {
    for (const [stem, doc] of nativeRuleDocs) {
      add({
        path: nativeRulePath(CURSOR_RULES_NAMESPACE, stem),
        content: renderCursorRule(doc),
        managed: true,
      })
    }
    addMcpConfig('.cursor/mcp.json', 'targets/cursor/mcp.json')
  }
  if (components.includes('copilot')) {
    for (const [stem, doc] of nativeRuleDocs) {
      add({
        path: nativeRulePath(COPILOT_RULES_NAMESPACE, stem),
        content: renderCopilotRule(doc),
        managed: true,
      })
    }
    addMcpConfig('.vscode/mcp.json', 'targets/copilot/mcp.json')
  }

  if (components.includes('codex')) {
    addMcpConfig('.codex/config.toml', 'targets/codex/config.toml')
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
    addMcpConfig('opencode.json', 'targets/opencode/opencode.json')
  }

  return [...planned.values()].sort((a, b) => a.path.localeCompare(b.path))
}
